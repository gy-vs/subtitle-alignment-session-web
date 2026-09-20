import type {Aligner, AlignerContext, Suggestion, TimeRange} from '../shared/types.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Default aligner: emits deterministic timing suggestions in two batches.
 * The first batch is intentionally reversed so consumers must cope with
 * out-of-order delivery. Emission is cancellation-aware.
 */
export class DefaultAligner implements Aligner {
  readonly name = 'default';

  async run(ctx: AlignerContext): Promise<void> {
    const suggestions = ctx.cues.map((cue, index): Suggestion => {
      const shift = 120 + index * 40;
      return {
        cueId: cue.id,
        baseline: {start: cue.start, end: cue.end},
        proposed: {start: cue.start + shift, end: cue.end + shift},
        confidence: 0.9 - index * 0.07,
        reason: `waveform drift +${shift}ms`,
      };
    });

    // Batch 1: every other cue, reversed arrival order.
    const firstBatch = suggestions.filter((_, index) => index % 2 === 0).reverse();
    for (const item of firstBatch) {
      if (ctx.isCancelled()) return;
      ctx.emit(item);
      await sleep(12);
    }

    // A refined correction for the second cue, simulating a second pass.
    const refined = suggestions[1];
    if (refined && !ctx.isCancelled()) {
      ctx.emit({
        ...refined,
        proposed: {start: refined.proposed.start + 15, end: refined.proposed.end + 15},
        confidence: 0.95,
        reason: 'refined pass',
      });
      await sleep(12);
    }

    // Batch 2: the remaining cues.
    for (let index = 0; index < suggestions.length; index += 1) {
      if (ctx.isCancelled()) return;
      if (index % 2 === 1 && suggestions[index] !== refined) {
        ctx.emit(suggestions[index]);
        await sleep(12);
      }
    }
  }
}

export interface ScriptedStep {
  /** Emit a suggestion. */
  emit?: Suggestion;
  /** Delay before processing this step. */
  delay?: number;
}

/**
 * Test aligner driven by an explicit script. An optional gate lets a test
 * hold the aligner at a specific point to create cancel/complete races:
 * the aligner pauses after emitting step `pauseAfter` until the test calls
 * `gate.release()`. Cancellation is re-checked when the gate opens, so
 * releasing after cancel models cancel-winning; releasing the final step
 * before cancelling models completion-winning.
 */
export interface Gate {
  /** Resolved by the test to let a paused aligner proceed. */
  readonly allow: Promise<void>;
  release(): void;
}

export function createGate(): Gate {
  let release!: () => void;
  const allow = new Promise<void>(resolve => {
    release = resolve;
  });
  return {allow, release};
}

export class ScriptedAligner implements Aligner {
  readonly name: string;
  private readonly steps: ScriptedStep[];
  private readonly gate: Gate | undefined;
  private readonly pauseAfter: number | undefined;
  /** Extra suggestions emitted regardless of cancellation (recorded ignored). */
  private readonly lateAfterCancel: Suggestion[] | undefined;

  constructor(options: {
    name?: string;
    steps: ScriptedStep[];
    pauseAfter?: number;
    gate?: Gate;
    lateAfterCancel?: Suggestion[];
  }) {
    this.name = options.name ?? 'scripted';
    this.steps = options.steps;
    this.pauseAfter = options.pauseAfter;
    this.gate = options.gate;
    this.lateAfterCancel = options.lateAfterCancel;
  }

  async run(ctx: AlignerContext): Promise<void> {
    if (this.pauseAfter === -1 && this.gate) {
      await this.gate.allow;
      if (ctx.isCancelled()) return;
    }
    for (let index = 0; index < this.steps.length; index += 1) {
      const step = this.steps[index];
      if (step.delay) await sleep(step.delay);
      if (step.emit) ctx.emit(step.emit);
      if (this.pauseAfter === index && this.gate) {
        await this.gate.allow;
        if (ctx.isCancelled()) return;
      }
    }
    if (this.lateAfterCancel?.length) {
      // Give cancellation a tick to land, then emit anyway. The server
      // records these as ignored rather than suggestions.
      await sleep(5);
      for (const item of this.lateAfterCancel) ctx.emit(item);
    }
  }
}

/** Build a simple suggestion for tests. */
export function suggestion(cueId: string, baseline: TimeRange, proposed: TimeRange, confidence = 0.8): Suggestion {
  return {cueId, baseline, proposed, confidence};
}
