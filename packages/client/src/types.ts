import type { ActivityEvent } from '@atriarch/tracery-core';

/**
 * Time source used by the tracer. `now()` supplies the wire `ts` (epoch
 * milliseconds); `monotonic()` supplies the clock `end()` uses to compute
 * `durationMs`. Overridable for tests; defaults to `Date.now` / `performance.now`.
 */
export interface Clock {
  now(): number;
  monotonic(): number;
}

export const defaultClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

/**
 * Sink an `ActivityTracer` flushes batches of events into. Implementations
 * must never throw into the caller: swallow and (optionally) log failures.
 */
export interface ActivityTransport {
  /** Deliver one batch. Resolve once the attempt (including any internal retries) is done. */
  send(events: readonly ActivityEvent[]): void | Promise<void>;
  /** Wait for any in-flight sends to settle. Optional; default is a no-op. */
  flush?(): void | Promise<void>;
  /** Best-effort drain and release resources. Optional; default is a no-op. */
  close?(): void | Promise<void>;
}

/** Minimal shape `journalTransport` accepts: `@atriarch/tracery-core`'s `Journal` satisfies this. */
export interface JournalLike {
  append(events: readonly ActivityEvent[]): unknown;
}
