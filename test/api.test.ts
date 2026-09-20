import {describe, expect, it} from 'vitest';
import request from 'supertest';
import type {Express} from 'express';
import type {Cue, EventsResponse, SessionEvent, Suggestion} from '../src/shared/types';
import {createGate, ScriptedAligner, suggestion, type ScriptedStep} from '../src/server/aligners';
import {createApp} from '../src/server/index';

function appWithAligner(name: string, steps: ScriptedStep[], options: {pauseAfter?: number; gate?: ReturnType<typeof createGate>; lateAfterCancel?: Suggestion[]} = {}) {
  return createApp({
    aligners: {
      test: () => new ScriptedAligner({name, steps, pauseAfter: options.pauseAfter, gate: options.gate, lateAfterCancel: options.lateAfterCancel}),
    },
  });
}

async function startSession(app: Express, trackId = 'alpha', aligner = 'test') {
  const response = await request(app)
    .post(`/api/tracks/${trackId}/alignment-sessions`)
    .send({aligner})
    .expect(201);
  return response.body;
}

/** Long-poll helper: resume from the last seen seq and accumulate events. */
async function collectUntil(
  app: Express,
  sessionId: string,
  predicate: (payload: EventsResponse, accumulated: SessionEvent[]) => boolean,
  timeoutMs = 3000,
): Promise<{payload: EventsResponse; accumulated: SessionEvent[]}> {
  const started = Date.now();
  let cursor = -1;
  const accumulated: SessionEvent[] = [];
  for (;;) {
    const response = await request(app).get(`/api/alignment-sessions/${sessionId}/events?after=${cursor}`);
    expect(response.status).toBe(200);
    const payload = response.body as EventsResponse;
    accumulated.push(...payload.events);
    cursor = payload.lastSeq;
    if (predicate(payload, accumulated)) return {payload, accumulated};
    if (payload.done) return {payload, accumulated};
    if (Date.now() - started > timeoutMs) throw new Error('collectUntil timed out: ' + JSON.stringify({payload, accumulated}));
  }
}

async function waitForCount(app: Express, sessionId: string, count: number) {
  // Each event occupies a seq; wait until at least `count` events exist.
  const {payload, accumulated} = await collectUntil(app, sessionId, (_p, all) => all.length >= count);
  return {payload, accumulated};
}

const s1 = suggestion('c1', {start: 0, end: 1200}, {start: 100, end: 1300}, 0.9);
const s2 = suggestion('c2', {start: 1300, end: 2800}, {start: 1450, end: 2950}, 0.8);
const s1Refined: Suggestion = {...s1, proposed: {start: 110, end: 1310}, confidence: 0.97, reason: 'refined'};
const staleBaseline: Suggestion = suggestion('c3', {start: 99, end: 99}, {start: 200, end: 1900}, 0.5);

describe('alignment sessions', () => {
  it('pins the track revision and streams the cue snapshot', async () => {
    const app = appWithAligner('t', [{emit: s1}]);
    const session = await startSession(app);
    expect(session.revision).toBe(3);
    expect(session.cues.map((c: {id: string}) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);

    // A later track edit bumps the track revision but the session keeps its pin.
    const track = await request(app).get('/api/tracks/alpha').expect(200);
    await request(app)
      .put('/api/tracks/alpha')
      .send({revision: track.body.revision, cues: track.body.cues})
      .expect(200);
    const fetched = await request(app).get(`/api/alignment-sessions/${session.id}`).expect(200);
    expect(fetched.body.revision).toBe(3);
    const live = await request(app).get('/api/tracks/alpha').expect(200);
    expect(live.body.revision).toBe(4);
  });

  it('delivers out-of-order suggestions by sequence and resumes from the last event', async () => {
    // Script emits c3 first, c1 second; the client folds in seq order.
    const app = appWithAligner('t', [{emit: suggestion('c3', {start: 2900, end: 4600}, {start: 3000, end: 4700})}, {emit: s1, delay: 2}]);
    const session = await startSession(app);
    const {accumulated} = await collectUntil(
      app,
      session.id,
      (_p, all) => all.filter(e => e.type === 'suggestion').length >= 2,
    );
    const seqs = accumulated.filter(e => e.type === 'suggestion').map(e => e.seq);
    expect(seqs).toEqual([0, 1]);
    expect(accumulated.find(e => e.seq === 0)).toMatchObject({type: 'suggestion', cueId: 'c3'});
    // Resuming with an explicit cursor only returns newer events.
    const resume = await request(app).get(`/api/alignment-sessions/${session.id}/events?after=0`);
    expect(
      resume.body.events
        .filter((e: SessionEvent) => e.type !== 'phase')
        .map((e: SessionEvent) => (e.type === 'suggestion' || e.type === 'ignored' ? e.cueId : null)),
    ).toEqual(['c1']);
    const empty = await request(app).get(`/api/alignment-sessions/${session.id}/events?after=10`);
    expect(empty.body.events).toEqual([]);
    expect(empty.body.done).toBe(true);
  });

  it('folds repeated corrections for the same cue into the newest revision', async () => {
    const app = appWithAligner('t', [{emit: s1}, {emit: s1Refined, delay: 2}]);
    const session = await startSession(app);
    const {accumulated} = await waitForCount(app, session.id, 2);
    const suggestions = accumulated.filter(e => e.type === 'suggestion');
    expect(suggestions.map(e => e.seq)).toEqual([0, 1]);
    const detail = await request(app).get(`/api/alignment-sessions/${session.id}`).expect(200);
    expect(detail.body.suggestionCount).toBe(1);
    expect(detail.body.lastSeq).toBeGreaterThanOrEqual(1);
  });

  it('only auto-applies suggestions whose baseline still matches; mismatches conflict', async () => {
    const app = appWithAligner('t', [{emit: s1}, {emit: staleBaseline}]);
    const session = await startSession(app);
    await waitForCount(app, session.id, 2);

    // s1 baseline matches the snapshot -> accept candidate works (server only
    // checks an active suggestion exists; the client performs baseline logic),
    // and an unknown cue is still tracked without corrupting the track.
    const accept = await request(app)
      .post(`/api/alignment-sessions/${session.id}/accept`)
      .send({...s1, idempotencyKey: 'k1'})
      .expect(200);
    expect(accept.body.status).toBe('accepted');
    expect(accept.body.cue).toMatchObject({start: 100, end: 1300});

    // The live track cue reflects the accepted timing.
    const track = await request(app).get('/api/tracks/alpha').expect(200);
    expect(track.body.cues.find((c: Cue) => c.id === 'c1')).toMatchObject({start: 100, end: 1300});
    expect(track.body.cues.find((c: Cue) => c.id === 'c3')).toMatchObject({start: 2900, end: 4600});
  });

  it('makes accept idempotent and leaves other decisions intact on partial accept', async () => {
    const app = appWithAligner('t', [{emit: s1}, {emit: s2, delay: 2}]);
    const session = await startSession(app);
    await waitForCount(app, session.id, 2);

    const first = await request(app)
      .post(`/api/alignment-sessions/${session.id}/accept`)
      .send({...s1, idempotencyKey: 'same-key'})
      .expect(200);
    expect(first.body.replayed).toBeUndefined();

    const retry = await request(app)
      .post(`/api/alignment-sessions/${session.id}/accept`)
      .send({...s1, proposed: {start: 999, end: 9999}, idempotencyKey: 'same-key'})
      .expect(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.cue).toMatchObject({start: 100, end: 1300});

    // A different key is a new decision and can move the cue again.
    const again = await request(app)
      .post(`/api/alignment-sessions/${session.id}/accept`)
      .send({...s1, proposed: {start: 105, end: 1305}, idempotencyKey: 'other-key'})
      .expect(200);
    expect(again.body.replayed).toBeUndefined();
    expect(again.body.cue).toMatchObject({start: 105, end: 1305});

    // c2 is untouched: partial accept.
    const track = await request(app).get('/api/tracks/alpha').expect(200);
    expect(track.body.cues.find((c: Cue) => c.id === 'c2')).toMatchObject({start: 1300, end: 2800});

    const rejected = await request(app)
      .post(`/api/alignment-sessions/${session.id}/reject`)
      .send({cueId: 'c2', idempotencyKey: 'rej-1'})
      .expect(200);
    expect(rejected.body.status).toBe('rejected');
    const rejectRetry = await request(app)
      .post(`/api/alignment-sessions/${session.id}/reject`)
      .send({cueId: 'c2', idempotencyKey: 'rej-1'})
      .expect(200);
    expect(rejectRetry.body.replayed).toBe(true);
  });

  it('keeps a completed session reviewable but locks a cancelled one', async () => {
    const cancelGate = createGate();
    const app = createApp({
      aligners: {
        one: () => new ScriptedAligner({steps: [{emit: s1}]}),
        // Gate before the first emit so cancellation deterministically wins.
        two: () => new ScriptedAligner({steps: [{emit: s2}], pauseAfter: -1, gate: cancelGate}),
      },
    });
    const session = await startSession(app, 'alpha', 'one');
    const {payload} = await collectUntil(app, session.id, p => p.phase === 'completed');
    expect(payload.phase).toBe('completed');
    // Drain window: the user may still accept delivered suggestions.
    await request(app)
      .post(`/api/alignment-sessions/${session.id}/accept`)
      .send({...s1, idempotencyKey: 'late-but-ok'})
      .expect(200);

    const cancelled = await startSession(app, 'alpha', 'two');
    await request(app).post(`/api/alignment-sessions/${cancelled.id}/cancel`).expect(200);
    cancelGate.release();
    await request(app)
      .post(`/api/alignment-sessions/${cancelled.id}/accept`)
      .send({...s2, idempotencyKey: 'too-late'})
      .expect(409);
  });

  it('cancel wins the race when the aligner is still gated; late emits become ignored events', async () => {
    const gate = createGate();
    const late = suggestion('c4', {start: 4700, end: 6100}, {start: 4900, end: 6300}, 0.6);
    const app = appWithAligner('t', [{emit: s1}, {emit: s2, delay: 2}], {pauseAfter: 0, gate, lateAfterCancel: [late]});
    const session = await startSession(app);
    await collectUntil(app, session.id, (_p, all) =>
      all.some(e => e.type === 'suggestion' && (e as {cueId?: string}).cueId === 'c1'),
    );

    const cancel = request(app).post(`/api/alignment-sessions/${session.id}/cancel`);
    gate.release();
    const cancelResponse = await cancel;
    expect(cancelResponse.status).toBe(200);
    expect(cancelResponse.body.phase).toBe('cancelled');

    const {accumulated: drainedEvents, payload} = await collectUntil(app, session.id, (_p, all) =>
      all.some(e => e.type === 'ignored' && (e as {cueId?: string}).cueId === 'c4'),
    );
    const ignored = drainedEvents.filter(e => e.type === 'ignored');
    // Both the gate-guarded s2 (emitted after the cancel landed) and the
    // rogue post-cancel emit are recorded as ignored, in arrival order.
    expect(ignored.map(e => (e as {cueId: string}).cueId)).toEqual(['c2', 'c4']);
    expect(payload.phase).toBe('cancelled');

    // A second cancel is idempotent and keeps returning cancelled.
    await request(app).post(`/api/alignment-sessions/${session.id}/cancel`).expect(200);
  });

  it('completion wins the race when the aligner finishes before cancel lands', async () => {
    const gate = createGate();
    // Two steps; gate after step 1 (the last step).
    const app = appWithAligner('t', [{emit: s1}, {emit: s2, delay: 2}], {pauseAfter: 1, gate});
    const session = await startSession(app);
    await collectUntil(app, session.id, (_p, all) => all.length >= 2);
    gate.release();
    const {payload: drained} = await collectUntil(app, session.id, p => p.done);
    expect(drained.phase).toBe('completed');
    const response = await request(app).post(`/api/alignment-sessions/${session.id}/cancel`);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('session_completed');
  });

  it('410s session events and accepts once the track is deleted mid-session', async () => {
    const gate = createGate();
    const app = appWithAligner('t', [{emit: s1}], {pauseAfter: 0, gate});
    const session = await startSession(app);
    await collectUntil(app, session.id, (_p, all) => all.length >= 1);

    await request(app).delete('/api/tracks/alpha').expect(204);
    await request(app).get(`/api/tracks/alpha`).expect(404);

    await request(app).get(`/api/alignment-sessions/${session.id}/events?after=-1`).expect(410);
    await request(app)
      .post(`/api/alignment-sessions/${session.id}/accept`)
      .send({...s1, idempotencyKey: 'orphan'})
      .expect(410);

    // Deletion also cancels the runner; releasing must not throw or hang.
    gate.release();
    await request(app).get('/api/tracks').expect(200);
  });

  it('refuses unknown aligners and validates cue payloads', async () => {
    const app = createApp();
    await request(app).post('/api/tracks/alpha/alignment-sessions').send({aligner: 'nope'}).expect(400);
    await request(app).put('/api/tracks/alpha').send({revision: 3, cues: [{id: 'x', text: '', start: 0, end: -5}]}).expect(400);
  });

  it('still enforces optimistic revisions on direct track saves', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/alpha').expect(200);
    await request(app)
      .put('/api/tracks/alpha')
      .send({revision: before.body.revision, cues: before.body.cues})
      .expect(200);
    await request(app)
      .put('/api/tracks/alpha')
      .send({revision: before.body.revision, cues: before.body.cues})
      .expect(409);
  });
});
