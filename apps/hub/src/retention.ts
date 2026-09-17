/**
 * Retention sweeper (SPEC.md §6 "Retention"): runs every 60s, deletes the
 * oldest complete flows first, never a running flow younger than the
 * retention window. The actual eligibility/ordering logic lives in each
 * `EventStore.sweep` implementation; this module just schedules it.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { EventStore } from './store/types.js';
import type { MetricsRegistry } from './metrics.js';

export interface RetentionOptions {
  readonly retentionHours: number;
  readonly maxEventsPerWorkspace: number;
  /** Sweep interval; defaults to 60s. Overridable for tests. */
  readonly intervalMs?: number;
  readonly now?: () => number;
  /** Logs a sweep failure (hub-9) instead of leaving it an unhandled rejection. Defaults to `console.error`. */
  readonly logger?: Pick<FastifyBaseLogger, 'error'>;
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
  const logger = options.logger ?? console;

  const runOnce = async (): Promise<void> => {
    const result = await store.sweep(now(), { retentionMs, maxEventsPerWorkspace: options.maxEventsPerWorkspace });
    metrics.recordSweep(result);
  };

  const timer = setInterval(() => {
    // hub-9: a rejected sweep (e.g. sqlite hitting SQLITE_BUSY or a read-only
    // volume) must not be an unhandled rejection -- that kills the whole hub
    // under Node's default `--unhandled-rejections=throw`, taking down ingest
    // for every workspace over one transient disk hiccup.
    void runOnce().catch((err) => logger.error({ err }, 'tracery: retention sweep failed'));
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}
