import express from 'express';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {
  AcceptBody,
  Aligner,
  Cue,
  DecisionResult,
  EventsResponse,
  RejectBody,
  SessionEvent,
  SessionDetail,
  SessionPhase,
  Suggestion,
  TimeRange,
} from '../shared/types.js';
import {DefaultAligner} from './aligners.js';

interface TrackRow {
  id: string;
  name: string;
  revision: number;
  cues: Cue[];
  updatedAt: string;
}

interface ServerSession {
  id: string;
  trackId: string;
  revision: number;
  cues: Cue[]; // snapshot the aligner was started against
  phase: SessionPhase;
  events: SessionEvent[]; // append-only, seq = index; may be appended out of order? see below
  nextSeq: number;
  alignerName: string;
  cancelled: boolean;
  done: boolean; // runner promise settled (completed or cancelled drained)
  eventWaiters: Array<() => void>;
  /** idempotencyKey -> first decision result */
  decisions: Map<string, DecisionResult>;
  /** cueId -> seq of the latest suggestion */
  latestSeq: Map<string, number>;
}

function seedCues(): Cue[] {
  return [
    {id: 'c1', text: 'Welcome back.', start: 0, end: 1200},
    {id: 'c2', text: 'Today we align subtitles.', start: 1300, end: 2800},
    {id: 'c3', text: 'Suggestions arrive in batches.', start: 2900, end: 4600},
    {id: 'c4', text: 'You stay in control.', start: 4700, end: 6100},
  ];
}

export function createApp(options: {aligners?: Record<string, () => Aligner>} = {}) {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  const alignerFactories: Record<string, () => Aligner> = {
    default: () => new DefaultAligner(),
    ...options.aligners,
  };

  const tracks: TrackRow[] = [
    {id: 'alpha', name: 'Primary timed cues', revision: 3, cues: seedCues(), updatedAt: new Date(0).toISOString()},
    {
      id: 'beta',
      name: 'Secondary timed cues',
      revision: 5,
      cues: seedCues().map(cue => ({...cue, id: `b-${cue.id}`})),
      updatedAt: new Date(1000).toISOString(),
    },
  ];
  const sessions = new Map<string, ServerSession>();

  function findTrack(id: string): TrackRow | undefined {
    return tracks.find(row => row.id === id);
  }

  function publicTrack(row: TrackRow) {
    return {id: row.id, name: row.name, revision: row.revision, updatedAt: row.updatedAt};
  }

  function appendEvent(session: ServerSession, event: SessionEvent) {
    session.events.push(event);
    for (const waiter of session.eventWaiters.splice(0)) waiter();
  }

  /**
   * Emit from an aligner runner. Suggestions emitted while the session is
   * cancelled are recorded as `ignored` events; they still carry a seq so a
   * reconnecting client eventually learns about them.
   */
  function emitFromRunner(session: ServerSession, item: Suggestion) {
    const seq = session.nextSeq++;
    if (session.cancelled) {
      appendEvent(session, {type: 'ignored', seq, cueId: item.cueId, suggestion: item, at: new Date().toISOString()});
    } else {
      session.latestSeq.set(item.cueId, seq);
      appendEvent(session, {type: 'suggestion', seq, at: new Date().toISOString(), ...item});
    }
  }

  function startRunner(session: ServerSession, aligner: Aligner) {
    const ctx = {
      revision: session.revision,
      cues: session.cues,
      isCancelled: () => session.cancelled,
      emit: (item: Suggestion) => emitFromRunner(session, item),
    };
    Promise.resolve()
      .then(() => aligner.run(ctx))
      .catch(() => undefined)
      .finally(() => {
        // A completed stream drains into a review window: the user can still
        // accept or reject the delivered suggestions. Only cancellation is
        // terminal. A cancelled session is terminal immediately.
        if (!session.cancelled && session.phase === 'running') {
          session.phase = 'completed';
          appendEvent(session, {type: 'phase', seq: session.nextSeq++, phase: 'completed', at: new Date().toISOString()});
        } else {
          session.phase = session.phase === 'completed' ? 'completed' : 'cancelled';
        }
        session.done = true;
        for (const waiter of session.eventWaiters.splice(0)) waiter();
      });
  }

  function summary(session: ServerSession) {
    let ignoredCount = 0;
    for (const event of session.events) if (event.type === 'ignored') ignoredCount += 1;
    return {
      id: session.id,
      trackId: session.trackId,
      revision: session.revision,
      phase: session.phase,
      lastSeq: session.events.length ? session.events[session.events.length - 1].seq : -1,
      suggestionCount: session.latestSeq.size,
      ignoredCount,
    };
  }

  // ---- tracks -------------------------------------------------------------

  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'subtitle-timing', count: tracks.length, cueCount: tracks.reduce((n, row) => n + row.cues.length, 0)}),
  );

  app.get('/api/tracks', (_req, res) => res.json(tracks.map(publicTrack)));

  app.get('/api/tracks/:id', (req, res) => {
    const row = findTrack(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json({...publicTrack(row), cues: row.cues});
  });

  app.put('/api/tracks/:id', (req, res) => {
    const row = findTrack(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (typeof req.body.revision !== 'number' || req.body.revision !== row.revision) {
      return res.status(409).json({error: 'revision_conflict', current: {...publicTrack(row), cues: row.cues}});
    }
    if (!Array.isArray(req.body.cues)) return res.status(400).json({error: 'invalid_cues'});
    const cues: Cue[] = [];
    for (const value of req.body.cues) {
      if (
        !value ||
        typeof value.id !== 'string' ||
        typeof value.text !== 'string' ||
        typeof value.start !== 'number' ||
        typeof value.end !== 'number' ||
        value.end < value.start
      ) {
        return res.status(400).json({error: 'invalid_cues'});
      }
      cues.push({id: value.id, text: value.text, start: value.start, end: value.end});
    }
    row.cues = cues;
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json({...publicTrack(row), cues: row.cues});
  });

  app.delete('/api/tracks/:id', (req, res) => {
    const index = tracks.findIndex(row => row.id === req.params.id);
    if (index === -1) return res.status(404).json({error: 'not_found'});
    tracks.splice(index, 1);
    // Running aligners on the deleted track keep emitting, but into sessions
    // whose events can no longer be fetched (410 below).
    for (const session of sessions.values()) {
      if (session.trackId === req.params.id) session.cancelled = true;
    }
    res.status(204).end();
  });

  // ---- alignment sessions -------------------------------------------------

  app.post('/api/tracks/:id/alignment-sessions', (req, res) => {
    const row = findTrack(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const name = typeof req.body?.aligner === 'string' ? req.body.aligner : 'default';
    const factory = alignerFactories[name];
    if (!factory) return res.status(400).json({error: 'unknown_aligner', aligner: name});

    const session: ServerSession = {
      id: randomUUID(),
      trackId: row.id,
      revision: row.revision, // pinned for the whole session
      cues: row.cues.map(cue => ({...cue})),
      phase: 'running',
      events: [],
      nextSeq: 0,
      alignerName: name,
      cancelled: false,
      done: false,
      eventWaiters: [],
      decisions: new Map(),
      latestSeq: new Map(),
    };
    sessions.set(session.id, session);
    startRunner(session, factory());
    const body: SessionDetail = {
      ...summary(session),
      cues: session.cues,
      events: session.events,
    };
    res.status(201).json(body);
  });

  function loadSession(req: express.Request, res: express.Response): ServerSession | undefined {
    const session = sessions.get(String(req.params.sid));
    if (!session) {
      res.status(404).json({error: 'session_not_found'});
      return undefined;
    }
    if (!findTrack(session.trackId)) {
      res.status(410).json({error: 'track_deleted'});
      return undefined;
    }
    return session;
  }

  function eventsPayload(session: ServerSession, afterSeq: number): EventsResponse {
    return {
      sessionId: session.id,
      phase: session.phase,
      revision: session.revision,
      lastSeq: session.nextSeq - 1,
      done: session.done,
      events: session.events.filter(event => event.seq > afterSeq),
    };
  }

  // Resume cursor: GET .../events?after=<lastSeq>. Long-polls while running.
  app.get('/api/alignment-sessions/:sid/events', (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    const after = Number.parseInt((req.query.after as string | undefined) ?? '-1', 10);
    const afterSeq = Number.isFinite(after) ? after : -1;

    const deliver = () => res.json(eventsPayload(session, afterSeq));

    const fresh = session.events.some(event => event.seq > afterSeq);
    if (fresh || session.done) return deliver();

    let timer: NodeJS.Timeout | undefined;
    const waiter = () => {
      if (timer) clearTimeout(timer);
      deliver();
    };
    session.eventWaiters.push(waiter);
    timer = setTimeout(() => {
      const index = session.eventWaiters.indexOf(waiter);
      if (index >= 0) session.eventWaiters.splice(index, 1);
      deliver(); // empty heartbeat; client re-issues with the same cursor
    }, 2_000);
    req.on('close', () => {
      if (timer) clearTimeout(timer);
      const index = session.eventWaiters.indexOf(waiter);
      if (index >= 0) session.eventWaiters.splice(index, 1);
    });
  });

  app.get('/api/alignment-sessions/:sid', (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    const body: SessionDetail = {...summary(session), cues: session.cues, events: session.events};
    res.json(body);
  });

  function validRange(value: unknown): value is TimeRange {
    return (
      !!value &&
      typeof value === 'object' &&
      typeof (value as TimeRange).start === 'number' &&
      typeof (value as TimeRange).end === 'number' &&
      (value as TimeRange).end >= (value as TimeRange).start
    );
  }

  app.post('/api/alignment-sessions/:sid/accept', (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    if (session.phase === 'cancelled') return res.status(409).json({error: 'session_cancelled'});
    const body = req.body as AcceptBody;
    if (!body || typeof body.cueId !== 'string' || typeof body.idempotencyKey !== 'string') {
      return res.status(400).json({error: 'invalid_accept'});
    }
    if (!validRange(body.baseline) || !validRange(body.proposed)) return res.status(400).json({error: 'invalid_accept'});

    const replayed = session.decisions.get(body.idempotencyKey);
    if (replayed) return res.json({...replayed, replayed: true});

    // A decision always targets the newest suggestion revision for this cue;
    // older corrections are superseded and cannot be accepted directly.
    const newestSeq = session.latestSeq.get(body.cueId);
    if (newestSeq === undefined) return res.status(409).json({error: 'no_active_suggestion'});
    const seq = newestSeq;

    // Accept mutates the pinned session snapshot and the live track cues.
    const cue = session.cues.find(item => item.id === body.cueId);
    if (!cue) return res.status(404).json({error: 'cue_not_found'});
    cue.start = body.proposed.start;
    cue.end = body.proposed.end;

    // The accept also lands on the live track; it is an explicit user
    // decision so it must not be blocked by the session-pinned revision.
    const row = findTrack(session.trackId);
    if (row) {
      const live = row.cues.find(item => item.id === body.cueId);
      if (live) {
        live.start = body.proposed.start;
        live.end = body.proposed.end;
      }
    }

    const result: DecisionResult = {cueId: body.cueId, seq, status: 'accepted', cue: {...cue}};
    session.decisions.set(body.idempotencyKey, result);
    res.json(result);
  });

  app.post('/api/alignment-sessions/:sid/reject', (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    if (session.phase === 'cancelled') return res.status(409).json({error: 'session_cancelled'});
    const body = req.body as RejectBody;
    if (!body || typeof body.cueId !== 'string' || typeof body.idempotencyKey !== 'string') {
      return res.status(400).json({error: 'invalid_reject'});
    }

    const replayed = session.decisions.get(body.idempotencyKey);
    if (replayed) return res.json({...replayed, replayed: true});

    const cue = session.cues.find(item => item.id === body.cueId);
    if (!cue) return res.status(404).json({error: 'cue_not_found'});
    const seq = session.latestSeq.get(body.cueId) ?? (typeof body.seq === 'number' ? body.seq : -1);
    const result: DecisionResult = {cueId: body.cueId, seq, status: 'rejected', cue: {...cue}};
    session.decisions.set(body.idempotencyKey, result);
    res.json(result);
  });

  // Cancel the session. Cancellation is recorded and acknowledged
  // immediately; an aligner that is still winding down records any further
  // emissions as `ignored`, which the event stream delivers afterwards.
  // Completion and cancel racing resolve deterministically: whichever marks
  // the phase first wins; the loser gets 409 with the settled phase.
  app.post('/api/alignment-sessions/:sid/cancel', (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    if (session.phase === 'completed') return res.status(409).json({error: 'session_completed'});
    if (!session.cancelled) {
      session.cancelled = true;
      session.phase = 'cancelled';
      appendEvent(session, {type: 'phase', seq: session.nextSeq++, phase: 'cancelled', at: new Date().toISOString()});
    }
    res.json(summary(session));
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
