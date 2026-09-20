import type {
  Aligner,
  AlignerEvent,
  AlignerSessionHandle,
  Cue,
  Decision,
  DecisionKind,
  DecisionSink,
  Suggestion,
  TrackSnapshot,
} from './types';

export type SessionPhase =
  /** Receiving events; suggestions can be reviewed. */
  | 'active'
  /** Aligner signalled completion; remaining suggestions stay reviewable. */
  | 'completed'
  /** User aborted; unconfirmed auto-applied cues were reverted. */
  | 'cancelled'
  /** Underlying track was deleted; nothing is reviewable anymore. */
  | 'invalidated';

export type SuggestionStatus =
  /** Auto-applied because the baseline still matched; not yet confirmed. */
  | 'applied'
  /** Needs a user decision (baseline mismatch, user edit, low confidence, revision). */
  | 'conflict'
  /** User accepted (optionally with a fine-tuned value). */
  | 'accepted'
  /** User rejected; any applied value was reverted. */
  | 'rejected'
  /** Recorded but never applicable (late arrival, cancel, track deletion). */
  | 'ignored';

export type ConflictReason = 'baseline-mismatch' | 'user-edited' | 'low-confidence' | 'revised';
export type IgnoredReason = 'cancelled' | 'completed' | 'track-deleted' | 'revision-mismatch' | 'unknown-cue';

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface SuggestionRecord {
  cueId: string;
  /** Seq of the event that produced the currently represented suggestion. */
  seq: number;
  eventId: string;
  suggestion: Suggestion;
  status: SuggestionStatus;
  conflictReason?: ConflictReason;
  ignoredReason?: IgnoredReason;
  /** Idempotency key of the latest decision for this record. */
  decisionKey?: string;
  /** Value this record last wrote onto the cue, if any. */
  appliedValue?: TimeRange;
}

export interface ViewItem {
  cueId: string;
  /** Index in the track's cue order; the list is always sorted by this. */
  order: number;
  status: SuggestionStatus;
  suggestion: Suggestion;
  current: TimeRange;
  original: TimeRange;
  /** Unsaved fine-tune; owned by the view layer, never folded away. */
  draft?: TimeRange;
  dirty: boolean;
  conflictReason?: ConflictReason;
  ignoredReason?: IgnoredReason;
}

export type AuditEntry =
  | { type: 'applied'; cueId: string; seq: number }
  | { type: 'conflict'; cueId: string; seq: number; reason: ConflictReason }
  | { type: 'reopened'; cueId: string; seq: number }
  | { type: 'superseded'; cueId: string; seq: number; keptSeq: number }
  | { type: 'duplicate-event'; eventId: string }
  | { type: 'ignored-suggestion'; cueId: string; seq: number; reason: IgnoredReason }
  | { type: 'ignored-event'; eventId: string; reason: 'revision-mismatch' | 'session-closed' }
  | { type: 'decision'; cueId: string; kind: DecisionKind; idempotencyKey: string }
  | { type: 'reverted'; cueId: string }
  | { type: 'user-edit'; cueId: string }
  | { type: 'completed'; eventId: string }
  | { type: 'cancelled' }
  | { type: 'track-deleted' };

export interface ReviewSessionOptions {
  aligner: Aligner;
  sink?: DecisionSink;
  /** Minimum confidence required for auto-apply; below it goes to conflict. Default 0. */
  autoApplyMinConfidence?: number;
  sessionId?: string;
}

const noopSink: DecisionSink = { submit: () => Promise.resolve() };

let fallbackCounter = 0;

function defaultSessionId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  fallbackCounter += 1;
  return `session-${Date.now()}-${fallbackCounter}`;
}

function sameRange(a: TimeRange, b: TimeRange): boolean {
  return a.startMs === b.startMs && a.endMs === b.endMs;
}

/**
 * Framework-agnostic engine behind the suggestion review UI.
 *
 * Folding rules (transport may be at-least-once and out of order):
 *  - events are deduped by eventId;
 *  - per cue, only the highest seq is represented; older arrivals are
 *    recorded as superseded and never resurrect;
 *  - within one batch, later items for the same cue replace earlier ones.
 *
 * Protection rules:
 *  - a cue the user edited since session start is dirty and never
 *    auto-overwritten; suggestions for it become conflicts;
 *  - a suggestion auto-applies only when its baseline still matches the
 *    current cue timing (or it replaces this session's own unconfirmed
 *    auto-applied value);
 *  - user decisions are never silently overwritten: a newer correction for
 *    an accepted/rejected cue reopens it as a conflict.
 */
export class SuggestionReviewSession {
  readonly sessionId: string;
  readonly trackId: string;
  readonly revision: number;

  private currentPhase: SessionPhase = 'active';
  private readonly aligner: Aligner;
  private readonly sink: DecisionSink;
  private readonly minConfidence: number;

  private readonly cues = new Map<string, Cue>();
  private readonly originals = new Map<string, TimeRange>();
  private readonly cueOrder = new Map<string, number>();
  private readonly dirtyCues = new Set<string>();
  private readonly records = new Map<string, SuggestionRecord>();
  private readonly drafts = new Map<string, TimeRange>();
  private readonly seenEvents = new Set<string>();
  private readonly decisionCounts = new Map<string, number>();
  private readonly enqueuedKeys = new Set<string>();
  private readonly outbox: Decision[] = [];
  private readonly audit: AuditEntry[] = [];
  private readonly listeners = new Set<() => void>();

  private handle: AlignerSessionHandle | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastEventId: string | null = null;
  private filter: ReadonlySet<SuggestionStatus> | null = null;
  private flushing = false;

  constructor(snapshot: TrackSnapshot, options: ReviewSessionOptions) {
    this.trackId = snapshot.trackId;
    this.revision = snapshot.revision;
    this.aligner = options.aligner;
    this.sink = options.sink ?? noopSink;
    this.minConfidence = options.autoApplyMinConfidence ?? 0;
    this.sessionId = options.sessionId ?? defaultSessionId();
    snapshot.cues.forEach((cue, index) => {
      this.cues.set(cue.id, { ...cue });
      this.originals.set(cue.id, { startMs: cue.startMs, endMs: cue.endMs });
      this.cueOrder.set(cue.id, index);
    });
  }

  // ---------------------------------------------------------------- lifecycle

  /** Open the aligner session pinned to the snapshot revision. */
  start(): void {
    if (this.handle) return;
    this.handle = this.aligner.startSession({
      sessionId: this.sessionId,
      trackId: this.trackId,
      revision: this.revision,
    });
    this.unsubscribe = this.handle.subscribe(null, (event) => this.onEvent(event));
  }

  /** Simulate/observe a transport drop; state is kept for resume. */
  disconnect(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resume the stream from the last processed event and flush pending decisions. */
  reconnect(): void {
    if (!this.unsubscribe && this.handle && this.canReview()) {
      this.unsubscribe = this.handle.subscribe(this.lastEventId, (event) => this.onEvent(event));
    }
    void this.flushOutbox();
  }

  /**
   * Abort the session. Unconfirmed auto-applied cues are reverted to their
   * original timing; accepted/rejected cues are left untouched. The
   * subscription is kept so late arrivals are still recorded as ignored.
   */
  cancel(): void {
    if (this.currentPhase === 'cancelled' || this.currentPhase === 'invalidated') return;
    this.currentPhase = 'cancelled';
    this.handle?.cancel();
    for (const record of this.records.values()) {
      if (record.status === 'applied') {
        const current = this.cues.get(record.cueId);
        const original = this.originals.get(record.cueId);
        if (current && original && record.appliedValue && sameRange(current, record.appliedValue)) {
          this.writeCue(record.cueId, original);
          this.audit.push({ type: 'reverted', cueId: record.cueId });
        }
        record.status = 'ignored';
        record.ignoredReason = 'cancelled';
      } else if (record.status === 'conflict') {
        record.status = 'ignored';
        record.ignoredReason = 'cancelled';
      }
    }
    this.audit.push({ type: 'cancelled' });
    this.emit();
  }

  /** The track underneath this session was deleted. */
  notifyTrackDeleted(): void {
    if (this.currentPhase === 'cancelled' || this.currentPhase === 'invalidated') return;
    this.currentPhase = 'invalidated';
    this.handle?.cancel();
    for (const record of this.records.values()) {
      if (record.status === 'applied' || record.status === 'conflict') {
        record.status = 'ignored';
        record.ignoredReason = 'track-deleted';
      }
    }
    this.audit.push({ type: 'track-deleted' });
    this.emit();
  }

  // ------------------------------------------------------------ review actions

  /**
   * Accept the current suggestion for a cue, optionally with an explicit
   * fine-tuned value (falls back to the unsaved draft, then the suggestion).
   * Retrying the same accept is a no-op; every distinct decision gets a fresh
   * idempotency key.
   */
  accept(cueId: string, override?: TimeRange): boolean {
    if (!this.canReview()) return false;
    const record = this.records.get(cueId);
    if (!record || record.status === 'ignored') return false;
    const value: TimeRange = override ??
      this.drafts.get(cueId) ?? { startMs: record.suggestion.startMs, endMs: record.suggestion.endMs };
    if (record.status === 'accepted' && record.appliedValue && sameRange(record.appliedValue, value)) {
      return true; // idempotent retry of the same decision
    }
    const key = this.nextDecisionKey('accept', record, value);
    this.writeCue(cueId, value);
    record.status = 'accepted';
    record.conflictReason = undefined;
    record.appliedValue = value;
    record.decisionKey = key;
    this.drafts.delete(cueId);
    this.enqueueDecision('accept', record, key, value);
    this.emit();
    return true;
  }

  /**
   * Reject the current suggestion. If the cue still holds this record's
   * applied value it is reverted to the original timing; user edits are
   * never clobbered.
   */
  reject(cueId: string): boolean {
    if (!this.canReview()) return false;
    const record = this.records.get(cueId);
    if (!record || record.status === 'ignored') return false;
    if (record.status === 'rejected') return true; // idempotent retry
    const key = this.nextDecisionKey('reject', record);
    const current = this.cues.get(cueId);
    const original = this.originals.get(cueId);
    if (current && original && record.appliedValue && sameRange(current, record.appliedValue)) {
      this.writeCue(cueId, original);
      this.audit.push({ type: 'reverted', cueId });
    }
    record.status = 'rejected';
    record.conflictReason = undefined;
    record.appliedValue = undefined;
    record.decisionKey = key;
    this.drafts.delete(cueId);
    this.enqueueDecision('reject', record, key);
    this.emit();
    return true;
  }

  /** Store an unsaved fine-tune for a cue; consumed by the next accept. */
  setDraft(cueId: string, range: TimeRange): boolean {
    const record = this.records.get(cueId);
    if (!record || (record.status !== 'applied' && record.status !== 'conflict')) return false;
    this.drafts.set(cueId, { startMs: range.startMs, endMs: range.endMs });
    this.emit();
    return true;
  }

  clearDraft(cueId: string): void {
    if (this.drafts.delete(cueId)) this.emit();
  }

  /**
   * The user edited a cue outside of this session's suggestions. The cue is
   * marked dirty so no late suggestion can auto-apply over it, and any live
   * suggestion for it becomes a conflict.
   */
  notifyUserEdit(cueId: string, range: TimeRange): boolean {
    if (!this.cues.has(cueId)) return false;
    this.writeCue(cueId, range);
    this.dirtyCues.add(cueId);
    this.audit.push({ type: 'user-edit', cueId });
    if (this.canReview()) {
      const record = this.records.get(cueId);
      if (record && (record.status === 'applied' || record.status === 'conflict')) {
        record.status = 'conflict';
        record.conflictReason = 'user-edited';
        record.appliedValue = undefined;
      }
    }
    this.emit();
    return true;
  }

  // -------------------------------------------------------------------- views

  /** All records in stable cue order, regardless of arrival order. */
  list(): ViewItem[] {
    return [...this.records.values()]
      .map((record) => this.toViewItem(record))
      .sort((a, b) => a.order - b.order);
  }

  /** `list()` narrowed by the current filter. Purely a view concern. */
  visible(): ViewItem[] {
    const items = this.list();
    if (!this.filter) return items;
    return items.filter((item) => this.filter!.has(item.status));
  }

  /** Restrict `visible()` to the given statuses (`null` = all). */
  setFilter(statuses: readonly SuggestionStatus[] | null): void {
    this.filter = statuses ? new Set(statuses) : null;
    this.emit();
  }

  summary(): Record<SuggestionStatus, number> {
    const counts: Record<SuggestionStatus, number> = { applied: 0, conflict: 0, accepted: 0, rejected: 0, ignored: 0 };
    for (const record of this.records.values()) counts[record.status] += 1;
    return counts;
  }

  cue(cueId: string): Cue | undefined {
    const cue = this.cues.get(cueId);
    return cue ? { ...cue } : undefined;
  }

  auditLog(): readonly AuditEntry[] {
    return this.audit;
  }

  get phase(): SessionPhase {
    return this.currentPhase;
  }

  get connected(): boolean {
    return this.unsubscribe !== null;
  }

  /** Resume token: id of the last processed event. */
  get resumeToken(): string | null {
    return this.lastEventId;
  }

  /** Subscribe to state changes (view binding). Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Deliver queued decisions to the sink, in order, at least once. */
  async flushOutbox(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbox.length > 0) {
        const decision = this.outbox[0];
        try {
          await this.sink.submit(decision);
          this.outbox.shift();
        } catch {
          break; // keep the queue; retried on the next flush/reconnect
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  // ---------------------------------------------------------------- internals

  private canReview(): boolean {
    return this.currentPhase === 'active' || this.currentPhase === 'completed';
  }

  private onEvent(event: AlignerEvent): void {
    if (this.seenEvents.has(event.eventId)) {
      this.audit.push({ type: 'duplicate-event', eventId: event.eventId });
      return;
    }
    this.seenEvents.add(event.eventId);
    this.lastEventId = event.eventId;
    if (event.revision !== this.revision) {
      this.audit.push({ type: 'ignored-event', eventId: event.eventId, reason: 'revision-mismatch' });
      return;
    }
    if (event.type === 'complete') {
      this.onComplete(event);
      this.emit();
      return;
    }
    if (this.currentPhase !== 'active') {
      const reason: IgnoredReason =
        this.currentPhase === 'completed' ? 'completed' : this.currentPhase === 'cancelled' ? 'cancelled' : 'track-deleted';
      for (const item of event.items) this.ignoreLate(item, event, reason);
      this.emit();
      return;
    }
    for (const item of event.items) this.intake(item, event);
    this.emit();
  }

  private onComplete(event: Extract<AlignerEvent, { type: 'complete' }>): void {
    if (this.currentPhase !== 'active') {
      this.audit.push({ type: 'ignored-event', eventId: event.eventId, reason: 'session-closed' });
      return;
    }
    this.currentPhase = 'completed';
    this.audit.push({ type: 'completed', eventId: event.eventId });
  }

  private intake(suggestion: Suggestion, event: Extract<AlignerEvent, { type: 'suggestions' }>): void {
    const cue = this.cues.get(suggestion.cueId);
    if (!cue) {
      this.audit.push({ type: 'ignored-suggestion', cueId: suggestion.cueId, seq: event.seq, reason: 'unknown-cue' });
      return;
    }
    const existing = this.records.get(suggestion.cueId);
    const stale =
      existing !== undefined &&
      (event.seq < existing.seq || (event.seq === existing.seq && event.eventId !== existing.eventId));
    if (stale) {
      this.audit.push({ type: 'superseded', cueId: suggestion.cueId, seq: event.seq, keptSeq: existing.seq });
      return;
    }

    const record: SuggestionRecord = {
      cueId: suggestion.cueId,
      seq: event.seq,
      eventId: event.eventId,
      suggestion: { ...suggestion },
      status: 'conflict',
    };
    const decided = existing?.status === 'accepted' || existing?.status === 'rejected';
    if (decided) {
      // A newer correction never silently overwrites a user decision.
      record.status = 'conflict';
      record.conflictReason = 'revised';
      this.audit.push({ type: 'reopened', cueId: suggestion.cueId, seq: event.seq });
    } else if (this.dirtyCues.has(suggestion.cueId)) {
      record.status = 'conflict';
      record.conflictReason = 'user-edited';
      this.audit.push({ type: 'conflict', cueId: suggestion.cueId, seq: event.seq, reason: 'user-edited' });
    } else if (suggestion.confidence < this.minConfidence) {
      record.status = 'conflict';
      record.conflictReason = 'low-confidence';
      this.audit.push({ type: 'conflict', cueId: suggestion.cueId, seq: event.seq, reason: 'low-confidence' });
    } else if (
      existing?.status === 'applied' ||
      sameRange(cue, { startMs: suggestion.baselineStartMs, endMs: suggestion.baselineEndMs })
    ) {
      // Baseline still matches, or this correction replaces our own
      // unconfirmed auto-applied value (the cue is untouched: not dirty).
      const value = { startMs: suggestion.startMs, endMs: suggestion.endMs };
      this.writeCue(suggestion.cueId, value);
      record.status = 'applied';
      record.appliedValue = value;
      this.audit.push({ type: 'applied', cueId: suggestion.cueId, seq: event.seq });
    } else {
      record.status = 'conflict';
      record.conflictReason = 'baseline-mismatch';
      this.audit.push({ type: 'conflict', cueId: suggestion.cueId, seq: event.seq, reason: 'baseline-mismatch' });
    }
    this.records.set(suggestion.cueId, record);
  }

  private ignoreLate(
    suggestion: Suggestion,
    event: Extract<AlignerEvent, { type: 'suggestions' }>,
    reason: IgnoredReason,
  ): void {
    this.audit.push({ type: 'ignored-suggestion', cueId: suggestion.cueId, seq: event.seq, reason });
    if (this.records.has(suggestion.cueId) || !this.cues.has(suggestion.cueId)) return;
    this.records.set(suggestion.cueId, {
      cueId: suggestion.cueId,
      seq: event.seq,
      eventId: event.eventId,
      suggestion: { ...suggestion },
      status: 'ignored',
      ignoredReason: reason,
    });
  }

  private writeCue(cueId: string, range: TimeRange): void {
    const cue = this.cues.get(cueId);
    if (!cue) return;
    cue.startMs = range.startMs;
    cue.endMs = range.endMs;
  }

  private nextDecisionKey(kind: DecisionKind, record: SuggestionRecord, value?: TimeRange): string {
    const n = (this.decisionCounts.get(record.cueId) ?? 0) + 1;
    this.decisionCounts.set(record.cueId, n);
    const base = `${this.sessionId}/${record.cueId}/${kind}/seq${record.seq}/dec${n}`;
    return value ? `${base}/${value.startMs}-${value.endMs}` : base;
  }

  private enqueueDecision(kind: DecisionKind, record: SuggestionRecord, key: string, value?: TimeRange): void {
    this.audit.push({ type: 'decision', cueId: record.cueId, kind, idempotencyKey: key });
    if (this.enqueuedKeys.has(key)) return;
    this.enqueuedKeys.add(key);
    this.outbox.push({
      idempotencyKey: key,
      sessionId: this.sessionId,
      trackId: this.trackId,
      revision: this.revision,
      cueId: record.cueId,
      kind,
      suggestionSeq: record.seq,
      appliedStartMs: value?.startMs,
      appliedEndMs: value?.endMs,
    });
    void this.flushOutbox();
  }

  private toViewItem(record: SuggestionRecord): ViewItem {
    const cue = this.cues.get(record.cueId)!;
    const original = this.originals.get(record.cueId)!;
    return {
      cueId: record.cueId,
      order: this.cueOrder.get(record.cueId) ?? Number.MAX_SAFE_INTEGER,
      status: record.status,
      suggestion: record.suggestion,
      current: { startMs: cue.startMs, endMs: cue.endMs },
      original: { ...original },
      draft: this.drafts.get(record.cueId),
      dirty: this.dirtyCues.has(record.cueId),
      conflictReason: record.conflictReason,
      ignoredReason: record.ignoredReason,
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
