/**
 * Shared types for the alignment-suggestion review session.
 *
 * The host editor opens a {@link TrackSnapshot} (track id + pinned revision +
 * cues in display order), an {@link Aligner} streams suggestion events for
 * that exact revision, and user decisions are persisted through a
 * {@link DecisionSink} keyed by idempotency keys.
 */

export interface Cue {
  id: string;
  startMs: number;
  endMs: number;
  text?: string;
}

export interface TrackSnapshot {
  trackId: string;
  /** Server-side revision the alignment session is pinned to. */
  revision: number;
  /** Cues in stable display order. */
  cues: Cue[];
}

export interface Suggestion {
  cueId: string;
  /** Cue timing the aligner observed at the pinned revision. */
  baselineStartMs: number;
  baselineEndMs: number;
  /** Suggested replacement timing. */
  startMs: number;
  endMs: number;
  /** 0..1, carried through for display and auto-apply policy. */
  confidence: number;
  note?: string;
}

export type AlignerEvent =
  | {
      type: 'suggestions';
      /** Unique, orderable event id used as the reconnect resume token. */
      eventId: string;
      /** Monotonic sequence number; the highest seq wins per cue. */
      seq: number;
      revision: number;
      items: Suggestion[];
    }
  | { type: 'complete'; eventId: string; seq: number; revision: number };

export interface AlignerSessionHandle {
  /**
   * Subscribe to the event stream. `sinceEventId` is exclusive: every event
   * after it is replayed (at-least-once), then live events follow.
   * Returns an unsubscribe function.
   */
  subscribe(sinceEventId: string | null, onEvent: (event: AlignerEvent) => void): () => void;
  /** Tell the aligner to stop; in-flight events may still arrive afterwards. */
  cancel(): void;
}

/** Injectable aligner port. */
export interface Aligner {
  startSession(args: { sessionId: string; trackId: string; revision: number }): AlignerSessionHandle;
}

export type DecisionKind = 'accept' | 'reject';

export interface Decision {
  /** Stable per logical decision; the server dedupes retries by this key. */
  idempotencyKey: string;
  sessionId: string;
  trackId: string;
  revision: number;
  cueId: string;
  kind: DecisionKind;
  /** Seq of the suggestion this decision refers to. */
  suggestionSeq: number;
  appliedStartMs?: number;
  appliedEndMs?: number;
}

/** Injectable persistence port for review decisions. */
export interface DecisionSink {
  submit(decision: Decision): Promise<void>;
}
