// Domain types shared by the alignment server, the client merge engine and tests.

/** Half-open time range in milliseconds. */
export interface TimeRange {
  start: number;
  end: number;
}

export interface Cue extends TimeRange {
  id: string;
  text: string;
}

export type SuggestionStatus =
  | 'pending' // auto-applied; user has not decided yet
  | 'conflict' // baseline drifted / cue was edited; needs a decision
  | 'accepted'
  | 'rejected'
  | 'ignored'; // arrived after the session was cancelled

export type ConflictReason = 'baseline-mismatch' | 'user-edited' | 'unknown-cue' | 'superseded-decision';

/**
 * A single cue timing proposal produced by an aligner.
 * `baseline` is the timing the aligner computed the suggestion against;
 * it must still match the live cue for the suggestion to auto-apply.
 */
export interface Suggestion {
  cueId: string;
  baseline: TimeRange;
  proposed: TimeRange;
  confidence: number; // 0..1
  reason?: string;
}

export interface IgnoredEvent {
  type: 'ignored';
  seq: number;
  cueId: string;
  suggestion: Suggestion;
  at: string;
}

export type SessionEvent =
  | ({type: 'suggestion'; seq: number; at: string} & Suggestion)
  | IgnoredEvent
  | {type: 'phase'; seq: number; phase: SessionPhase; at: string};

export type SessionPhase = 'running' | 'cancelled' | 'completed';

export interface SessionSummary {
  id: string;
  trackId: string;
  /** Track revision pinned when the session was created. */
  revision: number;
  phase: SessionPhase;
  /** Last sequence number handed out; -1 before any event exists. */
  lastSeq: number;
  suggestionCount: number;
  ignoredCount: number;
}

export interface SessionDetail extends SessionSummary {
  cues: Cue[];
  events: SessionEvent[];
}

export interface EventsResponse {
  sessionId: string;
  phase: SessionPhase;
  /** Server revision of the track, pinned for the life of the session. */
  revision: number;
  /** Highest sequence the server has stored (events may be observed out of order). */
  lastSeq: number;
  done: boolean; // true when phase is terminal AND every produced event was delivered
  events: SessionEvent[];
}

export interface AcceptBody extends Suggestion {
  /** Client-generated idempotency key, unique per accept attempt. */
  idempotencyKey: string;
}

export interface RejectBody {
  cueId: string;
  /** Seq of the suggestion revision being rejected. */
  seq: number;
  idempotencyKey: string;
}

export interface DecisionResult {
  cueId: string;
  seq: number;
  status: 'accepted' | 'rejected';
  cue: Cue;
  /** True when this response was replayed from a prior request with the same key. */
  replayed?: boolean;
}

/**
 * An injectable aligner. Aligners run asynchronously and may emit suggestions
 * in several batches. They must stop producing as soon as the session is
 * cancelled; anything still emitted afterwards is recorded as ignored.
 */
export interface Aligner {
  readonly name: string;
  run(ctx: AlignerContext): Promise<void>;
}

export interface AlignerContext {
  /** Track revision pinned for this alignment session. */
  readonly revision: number;
  readonly cues: readonly Cue[];
  emit(suggestion: Suggestion): void;
  isCancelled(): boolean;
}

export class SessionClosedError extends Error {
  constructor(message = 'session closed') {
    super(message);
    this.name = 'SessionClosedError';
  }
}

export class TrackDeletedError extends Error {
  constructor(message = 'track deleted') {
    super(message);
    this.name = 'TrackDeletedError';
  }
}
