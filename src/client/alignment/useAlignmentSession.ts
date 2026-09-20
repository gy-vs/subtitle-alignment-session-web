import {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import type {Cue, DecisionResult} from '../../shared/types';
import {decisionKey, editorReducer, initialEditorState, type EditorState, type SuggestionEntry} from './editor';

interface TrackPayload {
  id: string;
  name: string;
  revision: number;
  cues: Cue[];
}

export type BusyKind = 'loading' | 'saving' | 'aligning' | 'accepting' | 'rejecting' | 'cancelling' | null;

async function jsonOrThrow(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? `http_${response.status}`) as Error & {status: number; body: unknown};
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export interface AlignmentApi {
  state: EditorState;
  busy: BusyKind;
  notice: string | null;
  loadTrack: (trackId: string) => Promise<void>;
  startAlignment: (aligner?: string) => Promise<void>;
  cancelSession: () => Promise<void>;
  editCue: (cueId: string, start: number, end: number) => void;
  tweak: (cueId: string, start: number, end: number) => void;
  discardTweak: (cueId: string) => void;
  accept: (entry: SuggestionEntry) => Promise<void>;
  reject: (entry: SuggestionEntry) => Promise<void>;
  saveTrack: () => Promise<void>;
  clearNotice: () => void;
}

export function useAlignmentSession(): AlignmentApi {
  const [state, dispatch] = useReducer(editorReducer, undefined, initialEditorState);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cancelledRef = useRef(false);

  const loadTrack = useCallback(async (trackId: string) => {
    cancelledRef.current = true; // stop any previous session's poll loop
    setBusy('loading');
    try {
      const payload = (await jsonOrThrow(await fetch(`/api/tracks/${trackId}`))) as TrackPayload;
      dispatch({type: 'track-loaded', trackId: payload.id, name: payload.name, revision: payload.revision, cues: payload.cues});
      setNotice(null);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  // ---- event stream: long-poll resumed from the last observed seq --------

  const poll = useCallback(async (sessionId: string) => {
    let cancelled = false;
    const stop = () => {
      cancelled = true;
    };
    stopWatching.current = stop;
    while (!cancelled) {
      const cursor = stateRef.current.session.lastSeen;
      let payload;
      try {
        payload = await jsonOrThrow(await fetch(`/api/alignment-sessions/${sessionId}/events?after=${cursor}`));
      } catch (error) {
        if (cancelled) return;
        if ((error as {status?: number}).status === 410) {
          dispatch({type: 'track-deleted'});
          setNotice('Track was deleted while aligning.');
          return;
        }
        // network blip / reconnect: continue from the same cursor
        await new Promise(resolve => setTimeout(resolve, 400));
        continue;
      }
      if (cancelled) return;
      dispatch({
        type: 'events',
        events: payload.events,
        phase: payload.phase,
        lastSeq: payload.lastSeq,
        done: payload.done,
      });
      if (payload.done) return;
    }
  }, []);

  const stopWatching = useRef<() => void>(() => undefined);

  useEffect(() => () => {
    cancelledRef.current = true;
    stopWatching.current();
  }, []);

  const startAlignment = useCallback(
    async (aligner = 'default') => {
      const trackId = stateRef.current.trackId;
      if (!trackId) return;
      setBusy('aligning');
      try {
        const payload = await jsonOrThrow(
          await fetch(`/api/tracks/${trackId}/alignment-sessions`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({aligner}),
          }),
        );
        cancelledRef.current = false;
        dispatch({type: 'session-started', id: payload.id, revision: payload.revision, cues: payload.cues});
        // Any events already produced before the first poll are folded too.
        dispatch({
          type: 'events',
          events: payload.events ?? [],
          phase: 'running',
          lastSeq: payload.lastSeq ?? -1,
          done: false,
        });
        void poll(payload.id);
        setNotice(null);
      } catch (error) {
        setNotice(`Could not start alignment: ${(error as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [poll],
  );

  const cancelSession = useCallback(async () => {
    const sessionId = stateRef.current.session.id;
    if (!sessionId) return;
    setBusy('cancelling');
    try {
      const payload = await jsonOrThrow(
        await fetch(`/api/alignment-sessions/${sessionId}/cancel`, {method: 'POST'}),
      );
      dispatch({type: 'events', events: [], phase: payload.phase, lastSeq: payload.lastSeq, done: false});
      setNotice(payload.phase === 'completed' ? 'Alignment completed just before cancel.' : 'Alignment session cancelled.');
      // The running poll loop keeps draining until `done`: ignored events may
      // still arrive as the aligner winds down, and they must be recorded.
    } catch (error) {
      if ((error as {status?: number}).status === 409) {
        setNotice('Alignment had already completed.');
      } else {
        setNotice(`Cancel failed: ${(error as Error).message}`);
      }
    } finally {
      setBusy(null);
    }
  }, [poll]);

  const editCue = useCallback((cueId: string, start: number, end: number) => {
    dispatch({type: 'cue-edited', cueId, range: {start, end}});
  }, []);

  const tweak = useCallback((cueId: string, start: number, end: number) => {
    dispatch({type: 'tweak', cueId, range: {start, end}});
  }, []);

  const discardTweak = useCallback((cueId: string) => {
    dispatch({type: 'discard-tweak', cueId});
  }, []);

  const accept = useCallback(async (entry: SuggestionEntry) => {
    const sessionId = stateRef.current.session.id;
    if (!sessionId) return;
    const cue = stateRef.current.cues.find(item => item.id === entry.cueId);
    if (!cue) return;
    setBusy('accepting');
    try {
      const key = decisionKey(sessionId, entry.cueId, entry.seq, 'accept');
      const result = (await jsonOrThrow(
        await fetch(`/api/alignment-sessions/${sessionId}/accept`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({
            cueId: entry.cueId,
            baseline: entry.baseline,
            proposed: entry.proposed,
            confidence: entry.confidence,
            reason: entry.reason,
            idempotencyKey: key,
          }),
        }),
      )) as DecisionResult;
      dispatch({type: 'accepted', cueId: entry.cueId, seq: result.seq, cue: result.cue});
    } catch (error) {
      if ((error as {status?: number}).status === 409) {
        setNotice(`Cannot accept: a newer correction arrived for ${entry.cueId}. Review the conflict.`);
      } else {
        setNotice(`Accept failed: ${(error as Error).message}`);
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const reject = useCallback(async (entry: SuggestionEntry) => {
    const sessionId = stateRef.current.session.id;
    if (!sessionId) return;
    setBusy('rejecting');
    try {
      const key = decisionKey(sessionId, entry.cueId, entry.seq, 'reject');
      await jsonOrThrow(
        await fetch(`/api/alignment-sessions/${sessionId}/reject`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({cueId: entry.cueId, seq: entry.seq, idempotencyKey: key}),
        }),
      );
      dispatch({type: 'rejected', cueId: entry.cueId, seq: entry.seq});
    } catch (error) {
      setNotice(`Reject failed: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, []);

  const saveTrack = useCallback(async () => {
    const current = stateRef.current;
    if (!current.trackId || current.revision === null) return;
    setBusy('saving');
    try {
      const payload = await jsonOrThrow(
        await fetch(`/api/tracks/${current.trackId}`, {
          method: 'PUT',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({revision: current.revision, cues: current.cues}),
        }),
      );
      dispatch({type: 'saved', revision: payload.revision, cues: payload.cues});
      setNotice('Saved.');
    } catch (error) {
      if ((error as {status?: number}).status === 409) {
        const body = (error as {body: TrackPayload}).body;
        if (body) dispatch({type: 'track-loaded', trackId: body.id, name: body.name, revision: body.revision, cues: body.cues});
        setNotice('Revision conflict: the track changed elsewhere; reloaded. Re-apply your edits.');
      } else {
        setNotice(`Save failed: ${(error as Error).message}`);
      }
    } finally {
      setBusy(null);
    }
  }, []);

  return {
    state,
    busy,
    notice,
    loadTrack,
    startAlignment,
    cancelSession,
    editCue,
    tweak,
    discardTweak,
    accept,
    reject,
    saveTrack,
    clearNotice: () => setNotice(null),
  };
}
