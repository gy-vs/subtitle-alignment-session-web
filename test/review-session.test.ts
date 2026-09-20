import { describe, expect, it } from 'vitest';
import { SuggestionReviewSession } from '../src/client/review/session';
import { InMemoryAligner, InMemoryDecisionSink } from '../src/client/review/memory';
import type { AlignerEvent, Suggestion, TrackSnapshot } from '../src/client/review/types';

const REV = 7;

function snapshot(): TrackSnapshot {
  return {
    trackId: 'track-1',
    revision: REV,
    cues: [
      { id: 'c1', startMs: 1000, endMs: 2000, text: 'one' },
      { id: 'c2', startMs: 3000, endMs: 4000, text: 'two' },
      { id: 'c3', startMs: 5000, endMs: 6000, text: 'three' },
    ],
  };
}

function sug(cueId: string, baseline: [number, number], suggested: [number, number], confidence = 0.9): Suggestion {
  return {
    cueId,
    baselineStartMs: baseline[0],
    baselineEndMs: baseline[1],
    startMs: suggested[0],
    endMs: suggested[1],
    confidence,
  };
}

function ev(eventId: string, seq: number, items: Suggestion[], revision = REV): AlignerEvent {
  return { type: 'suggestions', eventId, seq, revision, items };
}

function done(eventId: string, seq: number, revision = REV): AlignerEvent {
  return { type: 'complete', eventId, seq, revision };
}

function setup(options: { autoApplyMinConfidence?: number } = {}) {
  const aligner = new InMemoryAligner();
  const sink = new InMemoryDecisionSink();
  const session = new SuggestionReviewSession(snapshot(), { aligner, sink, sessionId: 's1', ...options });
  session.start();
  const handle = aligner.handles[0];
  return { aligner, sink, session, handle };
}

describe('auto-apply and conflicts', () => {
  it('auto-applies a suggestion whose baseline still matches', () => {
    const { session, handle } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200])]));
    const [item] = session.list();
    expect(item.status).toBe('applied');
    expect(session.cue('c1')).toMatchObject({ startMs: 1200, endMs: 2200 });
  });

  it('routes a stale baseline to conflict without touching the cue', () => {
    const { session, handle } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1050, 2000], [1200, 2200])]));
    const [item] = session.list();
    expect(item.status).toBe('conflict');
    expect(item.conflictReason).toBe('baseline-mismatch');
    expect(session.cue('c1')).toMatchObject({ startMs: 1000, endMs: 2000 });
  });

  it('can require a minimum confidence for auto-apply', () => {
    const { session, handle } = setup({ autoApplyMinConfidence: 0.8 });
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200], 0.5)]));
    expect(session.list()[0].status).toBe('conflict');
    expect(session.list()[0].conflictReason).toBe('low-confidence');
  });

  it('pins the track revision and ignores events from any other revision', () => {
    const { session, handle } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200])], REV + 1));
    expect(session.list()).toHaveLength(0);
    expect(session.auditLog()).toContainEqual({ type: 'ignored-event', eventId: 'e1', reason: 'revision-mismatch' });
  });

  it('ignores suggestions for cues that are not in the track', () => {
    const { session, handle } = setup();
    handle.emit(ev('e1', 1, [sug('ghost', [0, 100], [50, 150])]));
    expect(session.list()).toHaveLength(0);
    expect(session.auditLog()).toContainEqual({ type: 'ignored-suggestion', cueId: 'ghost', seq: 1, reason: 'unknown-cue' });
  });
});

describe('out-of-order and repeated corrections', () => {
  it('folds corrections that arrive out of order; the highest seq wins', () => {
    const { session, handle } = setup();
    handle.emit(ev('e2', 2, [sug('c1', [1000, 2000], [1300, 2300])]));
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200])])); // stale, arrives late
    expect(session.cue('c1')).toMatchObject({ startMs: 1300, endMs: 2300 });
    expect(session.list()[0].suggestion.startMs).toBe(1300);
    expect(session.auditLog()).toContainEqual({ type: 'superseded', cueId: 'c1', seq: 1, keptSeq: 2 });
  });

  it('lets later items win when one batch corrects the same cue twice', () => {
    const { session, handle } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200]), sug('c1', [1000, 2000], [1300, 2300])]));
    expect(session.list()).toHaveLength(1);
    expect(session.cue('c1')).toMatchObject({ startMs: 1300, endMs: 2300 });
  });

  it('replaces unconfirmed auto-applied values, but never a user decision', () => {
    const { session, handle } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200])]));
    expect(session.cue('c1')).toMatchObject({ startMs: 1200, endMs: 2200 });
    // aligner corrects itself: the unconfirmed auto-applied value is replaced
    handle.emit(ev('e2', 2, [sug('c1', [1000, 2000], [1300, 2300])]));
    expect(session.cue('c1')).toMatchObject({ startMs: 1300, endMs: 2300 });
    expect(session.list()).toHaveLength(1);
    // user confirms v2; a further correction reopens a conflict instead of overwriting
    expect(session.accept('c1')).toBe(true);
    handle.emit(ev('e3', 3, [sug('c1', [1000, 2000], [1400, 2400])]));
    const [item] = session.list();
    expect(item.status).toBe('conflict');
    expect(item.conflictReason).toBe('revised');
    expect(item.suggestion.startMs).toBe(1400);
    expect(session.cue('c1')).toMatchObject({ startMs: 1300, endMs: 2300 });
  });
});

describe('user edits win over late suggestions', () => {
  it('never auto-applies over a cue the user edited first', () => {
    const { session, handle } = setup();
    expect(session.notifyUserEdit('c2', { startMs: 3100, endMs: 4100 })).toBe(true);
    handle.emit(ev('e1', 1, [sug('c2', [3000, 4000], [3300, 4300])]));
    const [item] = session.list();
    expect(item.status).toBe('conflict');
    expect(item.conflictReason).toBe('user-edited');
    expect(item.dirty).toBe(true);
    expect(session.cue('c2')).toMatchObject({ startMs: 3100, endMs: 4100 });
  });

  it('turns an auto-applied suggestion into a conflict when the user edits the cue', () => {
    const { session, handle } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200])]));
    expect(session.list()[0].status).toBe('applied');
    session.notifyUserEdit('c1', { startMs: 1100, endMs: 2100 });
    expect(session.list()[0].status).toBe('conflict');
    expect(session.list()[0].conflictReason).toBe('user-edited');
    expect(session.cue('c1')).toMatchObject({ startMs: 1100, endMs: 2100 });
  });
});

describe('review decisions', () => {
  it('accepts, fine-tunes and rejects cues independently (partial acceptance)', async () => {
    const { session, handle, sink } = setup();
    handle.emit(
      ev('e1', 1, [
        sug('c1', [1000, 2000], [1200, 2200]),
        sug('c2', [3000, 4000], [3300, 4300]),
        sug('c3', [5100, 6000], [5200, 6200]), // baseline mismatch -> conflict
      ]),
    );
    expect(session.list().map((i) => [i.cueId, i.status])).toEqual([
      ['c1', 'applied'],
      ['c2', 'applied'],
      ['c3', 'conflict'],
    ]);
    // fine-tune c1 while accepting
    expect(session.accept('c1', { startMs: 1250, endMs: 2250 })).toBe(true);
    // reject the auto-applied c2: the cue reverts to its original timing
    expect(session.reject('c2')).toBe(true);
    expect(session.cue('c2')).toMatchObject({ startMs: 3000, endMs: 4000 });
    // c3 stays an untouched conflict
    expect(session.cue('c3')).toMatchObject({ startMs: 5000, endMs: 6000 });
    await session.flushOutbox();
    expect(sink.received.map((d) => [d.kind, d.cueId])).toEqual([
      ['accept', 'c1'],
      ['reject', 'c2'],
    ]);
    expect(session.summary()).toEqual({ applied: 0, conflict: 1, accepted: 1, rejected: 1, ignored: 0 });
  });

  it('accepts with the unsaved fine-tune when no explicit override is given', async () => {
    const { session, handle, sink } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1050, 2000], [1200, 2200])])); // conflict
    expect(session.setDraft('c1', { startMs: 1250, endMs: 2250 })).toBe(true);
    expect(session.accept('c1')).toBe(true);
    expect(session.cue('c1')).toMatchObject({ startMs: 1250, endMs: 2250 });
    await session.flushOutbox();
    expect(sink.keys).toEqual(['s1/c1/accept/seq1/dec1/1250-2250']);
    expect(session.list()[0].draft).toBeUndefined(); // draft consumed
  });

  it('accept is idempotent per decision and retries delivery with the same key', async () => {
    const { session, handle, sink } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200])]));
    expect(session.accept('c1')).toBe(true);
    expect(session.accept('c1')).toBe(true); // retry of the same decision: no-op
    await session.flushOutbox();
    expect(sink.keys).toEqual(['s1/c1/accept/seq1/dec1/1200-2200']);

    // a transient sink failure keeps the decision queued for the next flush
    handle.emit(ev('e2', 2, [sug('c2', [3000, 4000], [3300, 4300])]));
    sink.failNext = 1;
    expect(session.accept('c2')).toBe(true);
    await session.flushOutbox();
    expect(sink.keys).toHaveLength(1); // c2 not delivered yet
    session.reconnect(); // also flushes the outbox
    await session.flushOutbox();
    expect(sink.keys).toEqual(['s1/c1/accept/seq1/dec1/1200-2200', 's1/c2/accept/seq2/dec1/3300-4300']);
    expect(session.cue('c2')).toMatchObject({ startMs: 3300, endMs: 4300 });
  });
});

describe('reconnect and late arrivals', () => {
  it('resumes from the last seen event after a reconnect', () => {
    const { session, handle } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200])]));
    session.disconnect();
    handle.emit(ev('e2', 2, [sug('c2', [3000, 4000], [3300, 4300])])); // buffered while offline
    expect(session.list()).toHaveLength(1);
    session.reconnect();
    expect(handle.subscribeCalls).toEqual([null, 'e1']); // resumed from the last event
    expect(session.list().map((i) => i.cueId)).toEqual(['c1', 'c2']);
    expect(session.cue('c2')).toMatchObject({ startMs: 3300, endMs: 4300 });
    // an at-least-once replay of an already-seen event is folded away
    handle.emit(ev('e2', 2, [sug('c2', [3000, 4000], [3300, 4300])]));
    expect(session.auditLog().filter((a) => a.type === 'duplicate-event')).toHaveLength(1);
    expect(session.list()).toHaveLength(2);
    expect(session.cue('c2')).toMatchObject({ startMs: 3300, endMs: 4300 });
  });

  it('reverts unconfirmed auto-applied cues on cancel and keeps accepted ones', () => {
    const { session, handle } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200]), sug('c2', [3000, 4000], [3300, 4300])]));
    expect(session.accept('c2')).toBe(true);
    session.cancel();
    expect(session.phase).toBe('cancelled');
    expect(session.cue('c1')).toMatchObject({ startMs: 1000, endMs: 2000 }); // reverted
    expect(session.cue('c2')).toMatchObject({ startMs: 3300, endMs: 4300 }); // kept
    const byId = new Map(session.list().map((i) => [i.cueId, i]));
    expect(byId.get('c1')?.status).toBe('ignored');
    expect(byId.get('c1')?.ignoredReason).toBe('cancelled');
    expect(byId.get('c2')?.status).toBe('accepted');
    expect(handle.cancelled).toBe(true);
  });

  it('records suggestions that arrive after cancel as ignored', () => {
    const { session, handle } = setup();
    session.cancel();
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200])]));
    const [item] = session.list();
    expect(item.status).toBe('ignored');
    expect(item.ignoredReason).toBe('cancelled');
    expect(session.cue('c1')).toMatchObject({ startMs: 1000, endMs: 2000 });
    expect(session.accept('c1')).toBe(false);
    expect(session.auditLog().some((a) => a.type === 'ignored-suggestion' && a.reason === 'cancelled')).toBe(true);
  });

  it('resolves the cancel/complete race deterministically', () => {
    // complete first, then cancel: cancel still closes the session
    const first = setup();
    first.handle.emit(done('e1', 1));
    expect(first.session.phase).toBe('completed');
    first.session.cancel();
    expect(first.session.phase).toBe('cancelled');
    // cancel first, then a late complete event: the complete is recorded as ignored
    const second = setup();
    second.session.cancel();
    second.handle.emit(done('e1', 1));
    expect(second.session.phase).toBe('cancelled');
    expect(second.session.auditLog()).toContainEqual({ type: 'ignored-event', eventId: 'e1', reason: 'session-closed' });
  });

  it('keeps remaining suggestions reviewable after the aligner completes', async () => {
    const { session, handle, sink } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200])]));
    handle.emit(done('e2', 2));
    expect(session.phase).toBe('completed');
    expect(session.accept('c1')).toBe(true);
    await session.flushOutbox();
    expect(sink.keys).toEqual(['s1/c1/accept/seq1/dec1/1200-2200']);
    // anything after completion is late and only recorded as ignored
    handle.emit(ev('e3', 3, [sug('c2', [3000, 4000], [3300, 4300])]));
    const late = session.list().find((i) => i.cueId === 'c2');
    expect(late?.status).toBe('ignored');
    expect(late?.ignoredReason).toBe('completed');
    expect(session.cue('c2')).toMatchObject({ startMs: 3000, endMs: 4000 });
  });

  it('invalidates the session when the underlying track is deleted', () => {
    const { session, handle } = setup();
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200]), sug('c2', [3100, 4000], [3300, 4300])]));
    session.notifyTrackDeleted();
    expect(session.phase).toBe('invalidated');
    const byId = new Map(session.list().map((i) => [i.cueId, i]));
    expect(byId.get('c1')?.status).toBe('ignored');
    expect(byId.get('c1')?.ignoredReason).toBe('track-deleted');
    expect(byId.get('c2')?.status).toBe('ignored');
    expect(session.accept('c1')).toBe(false);
    expect(session.reject('c2')).toBe(false);
    handle.emit(ev('e2', 2, [sug('c3', [5000, 6000], [5500, 6500])]));
    expect(session.list().find((i) => i.cueId === 'c3')?.ignoredReason).toBe('track-deleted');
  });
});

describe('listing, filtering and drafts', () => {
  it('lists in stable cue order and filtering never disturbs folding or drafts', () => {
    const { session, handle } = setup();
    // arrival order is c3 then c1; the listing stays in cue order
    handle.emit(ev('e1', 1, [sug('c3', [5100, 6000], [5500, 6500])])); // conflict
    handle.emit(ev('e2', 2, [sug('c1', [1000, 2000], [1200, 2200])])); // applied
    expect(session.list().map((i) => i.cueId)).toEqual(['c1', 'c3']);

    session.setFilter(['conflict']);
    expect(session.visible().map((i) => i.cueId)).toEqual(['c3']);

    // folding continues for the hidden cue, and a fine-tune draft sticks to it
    handle.emit(ev('e3', 3, [sug('c1', [1000, 2000], [1300, 2300])]));
    expect(session.setDraft('c1', { startMs: 1350, endMs: 2350 })).toBe(true);

    session.setFilter(null);
    const c1 = session.list().find((i) => i.cueId === 'c1')!;
    expect(c1.suggestion.startMs).toBe(1300); // folded to the newer correction
    expect(c1.status).toBe('applied');
    expect(c1.draft).toEqual({ startMs: 1350, endMs: 2350 }); // draft survived filtering
    expect(session.list().map((i) => i.cueId)).toEqual(['c1', 'c3']);
  });

  it('notifies subscribers on state changes', () => {
    const { session, handle } = setup();
    let calls = 0;
    const stop = session.subscribe(() => {
      calls += 1;
    });
    handle.emit(ev('e1', 1, [sug('c1', [1000, 2000], [1200, 2200])]));
    session.accept('c1');
    stop();
    session.reject('c1');
    expect(calls).toBe(2);
  });
});
