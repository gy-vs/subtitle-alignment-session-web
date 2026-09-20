import {describe, expect, it} from 'vitest';
import type {Cue, SessionEvent, Suggestion} from '../src/shared/types';
import {decisionKey, editorReducer, entryCounts, initialEditorState, selectEntries} from '../src/client/alignment/editor';

const cues: Cue[] = [
  {id: 'c1', text: 'one', start: 0, end: 1000},
  {id: 'c2', text: 'two', start: 1100, end: 2000},
  {id: 'c3', text: 'three', start: 2100, end: 3000},
];

function loaded(): ReturnType<typeof editorReducer> {
  return editorReducer(initialEditorState(), {
    type: 'track-loaded',
    trackId: 'alpha',
    name: 'Alpha',
    revision: 3,
    cues: cues.map(c => ({...c})),
  });
}

function started(state = loaded()): ReturnType<typeof editorReducer> {
  return editorReducer(state, {type: 'session-started', id: 'sess', revision: 3, cues: cues.map(c => ({...c}))});
}

function suggestionEvent(seq: number, s: Suggestion): SessionEvent {
  return {type: 'suggestion', seq, at: new Date().toISOString(), ...s};
}

const s1: Suggestion = {
  cueId: 'c1',
  baseline: {start: 0, end: 1000},
  proposed: {start: 120, end: 1120},
  confidence: 0.9,
};
const s2: Suggestion = {
  cueId: 'c2',
  baseline: {start: 1100, end: 2000},
  proposed: {start: 1250, end: 2150},
  confidence: 0.7,
};
const drift: Suggestion = {
  cueId: 'c3',
  baseline: {start: 900, end: 1800},
  proposed: {start: 1000, end: 1900},
  confidence: 0.5,
};
const refined: Suggestion = {...s1, proposed: {start: 130, end: 1130}, confidence: 0.97};

function feed(state: ReturnType<typeof started>, events: SessionEvent[], phase: 'running' | 'cancelled' | 'completed' = 'running', done = false) {
  return editorReducer(state, {
    type: 'events',
    events,
    phase,
    lastSeq: Math.max(...events.map(e => e.seq), -1),
    done,
  });
}

describe('editor merge engine', () => {
  it('auto-applies suggestions whose baseline matches and parks drifts as conflicts', () => {
    let state = started();
    state = feed(state, [suggestionEvent(0, s1), suggestionEvent(1, drift)]);
    expect(state.cues.find(c => c.id === 'c1')).toMatchObject({start: 120, end: 1120});
    expect(state.entries.c1.status).toBe('pending');
    expect(state.cues.find(c => c.id === 'c3')).toMatchObject({start: 2100, end: 3000});
    expect(state.entries.c3.status).toBe('conflict');
    expect(state.entries.c3.conflictReason).toBe('baseline-mismatch');
  });

  it('merges out-of-order batches identically to in-order delivery', () => {
    const forward = feed(started(), [suggestionEvent(0, s1), suggestionEvent(1, s2)]);
    const reversed = feed(started(), [suggestionEvent(1, s2), suggestionEvent(0, s1)]);
    expect(reversed.cues).toEqual(forward.cues);
    expect(reversed.entries).toEqual(forward.entries);
  });

  it('re-folds nothing when the resume cursor replays old events', () => {
    let state = started();
    state = feed(state, [suggestionEvent(0, s1)]);
    const once = state.cues.find(c => c.id === 'c1')!.start;
    state = feed(state, [suggestionEvent(0, s1)]);
    expect(state.cues.find(c => c.id === 'c1')!.start).toBe(once);
    expect(state.entries.c1.eventSeqs).toEqual([0]);
    expect(state.session.lastSeen).toBe(0);
  });

  it('chains a multi-batch correction while the cue is untouched', () => {
    let state = started();
    state = feed(state, [suggestionEvent(0, s1), suggestionEvent(2, refined)]);
    expect(state.entries.c1.status).toBe('pending');
    expect(state.cues.find(c => c.id === 'c1')).toMatchObject({start: 130, end: 1130});
    expect(state.entries.c1.eventSeqs).toEqual([0, 2]);
    expect(state.entries.c1.lastApplied).toMatchObject({seq: 2});
  });

  it('never overwrites a cue the user edited first', () => {
    let state = started();
    state = editorReducer(state, {type: 'cue-edited', cueId: 'c1', range: {start: 50, end: 1050}});
    state = feed(state, [suggestionEvent(0, s1)]);
    expect(state.cues.find(c => c.id === 'c1')).toMatchObject({start: 50, end: 1050});
    expect(state.entries.c1.status).toBe('conflict');
    expect(state.entries.c1.conflictReason).toBe('user-edited');

    // a later correction is still surfaced, still not applied
    state = feed(state, [suggestionEvent(3, refined)]);
    expect(state.cues.find(c => c.id === 'c1')).toMatchObject({start: 50, end: 1050});
    expect(state.entries.c1.status).toBe('conflict');
  });

  it('protects cues edited before the session started', () => {
    let state = loaded();
    state = editorReducer(state, {type: 'cue-edited', cueId: 'c2', range: {start: 1180, end: 2200}});
    state = started(state);
    state = feed(state, [suggestionEvent(0, s2)]);
    expect(state.cues.find(c => c.id === 'c2')).toMatchObject({start: 1180, end: 2200});
    expect(state.entries.c2.status).toBe('conflict');
    expect(state.entries.c2.conflictReason).toBe('user-edited');
  });

  it('treats a correction arriving after accept/reject as a superseding conflict', () => {
    let state = started();
    state = feed(state, [suggestionEvent(0, s1)]);
    state = editorReducer(state, {
      type: 'accepted',
      cueId: 'c1',
      seq: 0,
      cue: {...cues[0], start: 120, end: 1120},
    });
    expect(state.entries.c1.status).toBe('accepted');
    state = feed(state, [suggestionEvent(4, refined)]);
    expect(state.entries.c1.status).toBe('conflict');
    expect(state.entries.c1.conflictReason).toBe('superseded-decision');
    // accepted timing intact
    expect(state.cues.find(c => c.id === 'c1')).toMatchObject({start: 120, end: 1120});

    // rejected branch restores baseline and also blocks the correction
    let other = started();
    other = feed(other, [suggestionEvent(0, s2)]);
    other = editorReducer(other, {type: 'rejected', cueId: 'c2', seq: 0});
    expect(other.entries.c2.status).toBe('rejected');
    expect(other.cues.find(c => c.id === 'c2')).toMatchObject({start: 1100, end: 2000});
    const refined2: Suggestion = {...s2, proposed: {start: 1300, end: 2200}};
    other = feed(other, [suggestionEvent(5, refined2)]);
    expect(other.entries.c2.status).toBe('conflict');
    expect(other.entries.c2.conflictReason).toBe('superseded-decision');
    expect(other.cues.find(c => c.id === 'c2')).toMatchObject({start: 1100, end: 2000});
  });

  it('supports a per-cue tweak that survives filtering and can be discarded', () => {
    let state = started();
    state = feed(state, [suggestionEvent(0, drift)]);
    state = editorReducer(state, {type: 'tweak', cueId: 'c3', range: {start: 1050, end: 1950}});
    expect(state.entries.c3.proposed).toMatchObject({start: 1050, end: 1950});
    expect(state.entries.c3.tweaked).toBe(true);

    // filtering only changes the view
    const all = selectEntries(state, 'all');
    const conflicts = selectEntries(state, 'conflict');
    expect(conflicts).toHaveLength(1);
    expect(state.entries.c3.proposed).toMatchObject({start: 1050, end: 1950});
    expect(all).toHaveLength(1);

    state = editorReducer(state, {type: 'discard-tweak', cueId: 'c3'});
    expect(state.entries.c3.tweaked).toBe(false);
    expect(state.entries.c3.proposed).toMatchObject(drift.proposed);
  });

  it('records post-cancel suggestions as ignored and rolls auto-applied cues back', () => {
    let state = started();
    state = feed(state, [suggestionEvent(0, s1), suggestionEvent(1, s2)]);
    expect(state.cues.find(c => c.id === 'c2')).toMatchObject({start: 1250, end: 2150});
    const late: SessionEvent = {
      type: 'ignored',
      seq: 2,
      at: new Date().toISOString(),
      cueId: 'c2',
      suggestion: s2,
    };
    state = feed(state, [late], 'cancelled');
    expect(state.entries.c2.status).toBe('ignored');
    expect(state.cues.find(c => c.id === 'c2')).toMatchObject({start: 1100, end: 2000});
    // c1 was auto-applied and not ignored -> stays
    expect(state.cues.find(c => c.id === 'c1')).toMatchObject({start: 120, end: 1120});
    expect(state.session.phase).toBe('cancelled');

    // an ignored entry arriving after a real decision does not downgrade it
    state = editorReducer(state, {
      type: 'accepted',
      cueId: 'c1',
      seq: 0,
      cue: {...cues[0], start: 120, end: 1120},
    });
    const ignoredC1: SessionEvent = {
      type: 'ignored',
      seq: 3,
      at: new Date().toISOString(),
      cueId: 'c1',
      suggestion: s1,
    };
    state = feed(state, [ignoredC1], 'cancelled');
    expect(state.entries.c1.status).toBe('accepted');
  });

  it('keeps the cue list stable and unknown-cue suggestions visible but harmless', () => {
    let state = started();
    const ghost: Suggestion = {
      cueId: 'c999',
      baseline: {start: 0, end: 0},
      proposed: {start: 1, end: 2},
      confidence: 0.1,
    };
    state = feed(state, [suggestionEvent(0, ghost), suggestionEvent(1, s2), suggestionEvent(2, s1)]);
    const ordered = selectEntries(state, 'all').map(e => e.cueId);
    expect(ordered).toEqual(['c1', 'c2', 'c999']); // known cues first in cue order, ghost last
    expect(state.entries.c999.status).toBe('conflict');
    expect(state.entries.c999.conflictReason).toBe('unknown-cue');
    expect(state.cues).toHaveLength(3);
    expect(entryCounts(state)).toMatchObject({all: 3, conflict: 1, pending: 2});
  });

  it('resets everything when the track is deleted', () => {
    let state = started();
    state = feed(state, [suggestionEvent(0, s1)]);
    state = editorReducer(state, {type: 'track-deleted'});
    expect(state.deleted).toBe(true);
    expect(state.entries).toEqual({});
    expect(state.cues).toEqual([]);
  });

  it('builds a stable idempotency key per session/cue/revision/decision', () => {
    expect(decisionKey('s', 'c1', 4, 'accept')).toBe('s:accept:c1:4');
    expect(decisionKey('s', 'c1', 5, 'accept')).not.toBe(decisionKey('s', 'c1', 4, 'accept'));
    expect(decisionKey('s', 'c1', 4, 'reject')).not.toBe(decisionKey('s', 'c1', 4, 'accept'));
  });
});
