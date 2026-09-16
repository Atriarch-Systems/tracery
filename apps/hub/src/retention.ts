/**
 * Retention sweeper (SPEC.md §6 "Retention"): runs every 60s, deletes the
 * oldest complete flows first, never a running flow younger than the
 * retention window. The actual eligibility/ordering logic lives in each
 * `EventStore.sweep` implementation; this module just schedules it.
 */
import type { EventStore } from './store/types.js';
import type { MetricsRegistry } from './metrics.js';

export interface RetentionOptions {
  readonly retentionHours: number;
  readonly maxEventsPerWorkspace: number;
  /** Sweep interval; defaults to 60s. Overridable for tests. */
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export interface RetentionHandle {
  stop(): void;
  /** Runs one sweep immediately, outside the interval. Used by tests. */
  runOnce(): Promise<void>;
}

export function startRetention(store: EventStore, metrics: MetricsRegistry, options: RetentionOptions): RetentionHandle {
  const retentionMs = options.retentionHours * 60 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? 60_000;

  const runOnce = async (): Promise<void> => {
    const result = await store.sweep(now(), { retentionMs, maxEventsPerWorkspace: options.maxEventsPerWorkspace });
    metrics.recordSweep(result);
  };

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}
