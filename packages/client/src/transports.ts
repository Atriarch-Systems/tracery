import type { ActivityBatch, ActivityEvent } from '@atriarch/tracery-core';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch/tracery-core';
import type { ActivityTransport, JournalLike } from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// httpTransport
// ---------------------------------------------------------------------------

export interface HttpTransportOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly workspace?: string;
  readonly fetch?: typeof fetch;
  /** Additional attempts after the first on network error or 5xx. Default 5. */
  readonly retries?: number;
  /** Base backoff; doubled each retry. Default 200ms. */
  readonly backoffMs?: number;
}

/**
 * Posts `ActivityBatch`es to `${baseUrl}/v1/events`. Retries network errors
 * and 5xx responses with exponential backoff; 4xx responses are not
 * retryable and are dropped. Never throws into the caller.
 */
export function httpTransport(options: HttpTransportOptions): ActivityTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('httpTransport: no fetch implementation available; pass { fetch }');
  }
  const url = `${options.baseUrl.replace(/\/+$/, '')}/v1/events`;
  const retries = options.retries ?? 5;
  const backoffMs = options.backoffMs ?? 200;

  return {
    async send(events: readonly ActivityEvent[]): Promise<void> {
      const batch: ActivityBatch = { v: ACTIVITY_CONTRACT_VERSION, workspace: options.workspace, events };
      const body = JSON.stringify(batch);
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await fetchImpl(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${options.apiKey}`,
            },
            body,
          });
          if (res.ok) return; // 2xx, including 207 partial-accept
          if (res.status < 500) return; // 4xx: not retryable, drop
          // 5xx: fall through to retry
        } catch {
          // network error: fall through to retry
        }
        if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
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
 * `@atriarch/tracery-core`'s `Journal`) instead of a network hub, for the
 * library-only usage mode.
 */
export function journalTransport(journal: JournalLike): ActivityTransport {
  return {
    send(events: readonly ActivityEvent[]): void {
      journal.append(events);
    },
  };
}
