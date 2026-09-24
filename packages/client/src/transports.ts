import type { ActivityBatch, ActivityEvent } from '@atriarch-systems/tracery-core';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch-systems/tracery-core';
import type { ActivityTransport, JournalLike } from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// httpTransport
// ---------------------------------------------------------------------------

export interface HttpTransportOptions {
  readonly baseUrl: string;
  /** Omit against a hub running in local mode (`authMode: 'none'`, task: "local mode") -- no `Authorization` header is sent at all. */
  readonly apiKey?: string;
  readonly workspace?: string;
  readonly fetch?: typeof fetch;
  /** Additional attempts after the first on network error or 5xx. Default 5. */
  readonly retries?: number;
  /** Base backoff; doubled each retry, capped at 10s, then jittered. Default 200ms. */
  readonly backoffMs?: number;
  /** Per-attempt request timeout, via `AbortSignal.timeout`. Default 10000ms (matches the Python SDK). */
  readonly timeoutMs?: number;
}

const MAX_BACKOFF_MS = 10_000;

/**
 * Posts `ActivityBatch`es to `${baseUrl}/v1/events`. Retries network errors,
 * timeouts and 5xx responses with capped, jittered exponential backoff; 4xx
 * responses are not retryable and are dropped. Never throws into the caller.
 */
export function httpTransport(options: HttpTransportOptions): ActivityTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (typeof fetchImpl !== 'function') {
    throw new Error('httpTransport: no fetch implementation available; pass { fetch }');
  }
  const url = `${options.baseUrl.replace(/\/+$/, '')}/v1/events`;
  const retries = options.retries ?? 5;
  const backoffMs = options.backoffMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async send(events: readonly ActivityEvent[]): Promise<void> {
      const batch: ActivityBatch = { v: ACTIVITY_CONTRACT_VERSION, workspace: options.workspace, events };
      const body = JSON.stringify(batch);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await fetchImpl(url, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.ok) return; // 2xx, including 207 partial-accept
          if (res.status < 500) return; // 4xx: not retryable, drop
          // 5xx: fall through to retry
        } catch {
          // network error, or the AbortError from a timed-out attempt: fall through to retry
        }
        if (attempt < retries) {
          const capped = Math.min(backoffMs * 2 ** attempt, MAX_BACKOFF_MS);
          // Full jitter: spreads out many clients retrying against the same
          // hub (e.g. after it restarts) instead of retrying in lockstep.
          await sleep(Math.random() * capped);
        }
      }
      // Retries exhausted; drop silently rather than throw into the caller.
    },
  };
}

// ---------------------------------------------------------------------------
// memoryTransport
// ---------------------------------------------------------------------------

export interface MemoryTransport extends ActivityTransport {
  /** Every batch handed to `send`, in order, for assertions in tests. */
  readonly batches: readonly (readonly ActivityEvent[])[];
}

/** Records every batch in memory instead of sending it anywhere. For tests. */
export function memoryTransport(): MemoryTransport {
  const batches: ActivityEvent[][] = [];
  return {
    batches,
    send(events: readonly ActivityEvent[]): void {
      batches.push([...events]);
    },
  };
}

// ---------------------------------------------------------------------------
// journalTransport
// ---------------------------------------------------------------------------

/**
 * Feeds batches straight into an in-process journal (e.g.
 * `@atriarch-systems/tracery-core`'s `Journal`) instead of a network hub, for the
 * library-only usage mode.
 */
export function journalTransport(journal: JournalLike): ActivityTransport {
  return {
    send(events: readonly ActivityEvent[]): void {
      journal.append(events);
    },
  };
}
