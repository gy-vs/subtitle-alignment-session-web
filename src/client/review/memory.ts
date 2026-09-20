import type { Aligner, AlignerEvent, AlignerSessionHandle, Decision, DecisionSink } from './types';

/**
 * In-memory aligner handle. Events are buffered in `emitted`, so a
 * subscriber that connects (or reconnects) with a `sinceEventId` token
 * replays exactly the events after it — mirroring the server contract.
 */
export class InMemoryAlignerHandle implements AlignerSessionHandle {
  readonly emitted: AlignerEvent[] = [];
  /** Every `sinceEventId` this handle was subscribed with, in order. */
  readonly subscribeCalls: Array<string | null> = [];
  cancelled = false;
  private readonly subscribers = new Set<(event: AlignerEvent) => void>();

  constructor(readonly args: { sessionId: string; trackId: string; revision: number }) {}

  subscribe(sinceEventId: string | null, onEvent: (event: AlignerEvent) => void): () => void {
    this.subscribeCalls.push(sinceEventId);
    this.subscribers.add(onEvent);
    // Replay the tail after the resume token. If the token is unknown
    // (e.g. compacted away) replay everything; the session dedupes.
    const index = sinceEventId === null ? 0 : this.emitted.findIndex((event) => event.eventId === sinceEventId) + 1;
    for (let i = Math.max(index, 0); i < this.emitted.length; i += 1) {
      onEvent(this.emitted[i]);
    }
    return () => {
      this.subscribers.delete(onEvent);
    };
  }

  emit(event: AlignerEvent): void {
    this.emitted.push(event);
    for (const subscriber of [...this.subscribers]) subscriber(event);
  }

  cancel(): void {
    this.cancelled = true;
  }
}

export class InMemoryAligner implements Aligner {
  readonly handles: InMemoryAlignerHandle[] = [];

  startSession(args: { sessionId: string; trackId: string; revision: number }): InMemoryAlignerHandle {
    const handle = new InMemoryAlignerHandle(args);
    this.handles.push(handle);
    return handle;
  }
}

/** In-memory decision sink; `failNext` simulates transient delivery failures. */
export class InMemoryDecisionSink implements DecisionSink {
  readonly received: Decision[] = [];
  failNext = 0;

  submit(decision: Decision): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error('decision sink unavailable'));
    }
    this.received.push(decision);
    return Promise.resolve();
  }

  get keys(): string[] {
    return this.received.map((decision) => decision.idempotencyKey);
  }
}
