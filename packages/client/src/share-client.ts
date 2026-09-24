/**
 * Public, unauthenticated read client for one share link (docs/SHARING.md).
 * The token in the URL is the only credential -- no API key, ever. Mirrors
 * `HubClient`'s read surface (`getFlow`/`getTrace`/`events`/`live`) but
 * scoped to exactly the one flow or trace the share names, via
 * `/v1/shares/:token/*` instead of `/v1/flows*`/`/v1/traces*`.
 */
import type { ActivityFrame, StoredEvent } from '@atriarch-systems/tracery-core';
import type { FlowSummary, Trace } from './hub-types.stub.js';
import type { ShareMeta } from './share-types.js';
import { connectLive, type LiveConnectOptions, type LiveDisposer } from './live-connect.js';

export interface ShareClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly WebSocket?: typeof WebSocket;
}

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

type QueryValue = string | number | undefined;

export class ShareClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl?: typeof WebSocket;

  constructor(options: ShareClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.WebSocketImpl = options.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('ShareClient: no fetch implementation available; pass { fetch }');
    }
  }

  private buildUrl(path: string, query?: Readonly<Record<string, QueryValue>>): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  private async getJson<T>(path: string, query?: Readonly<Record<string, QueryValue>>): Promise<T> {
    const res = await this.fetchImpl(this.buildUrl(path, query));
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as ErrorBody;
        if (body.error?.message) message = body.error.message;
      } catch {
        // response body wasn't JSON; keep the status-line message
      }
      throw new Error(`ShareClient request to ${path} failed: ${message}`);
    }
    return (await res.json()) as T;
  }

  /** `GET /v1/shares/:token/meta`. */
  meta(): Promise<ShareMeta> {
    return this.getJson<ShareMeta>(`/v1/shares/${encodeURIComponent(this.token)}/meta`);
  }

  /** `GET /v1/shares/:token/flow`. 404s (throws) when the share's target isn't a flow. */
  flow(): Promise<FlowSummary> {
    return this.getJson<FlowSummary>(`/v1/shares/${encodeURIComponent(this.token)}/flow`);
  }

  /** `GET /v1/shares/:token/trace`. 404s (throws) when the share's target isn't a trace. */
  trace(): Promise<Trace> {
    return this.getJson<Trace>(`/v1/shares/${encodeURIComponent(this.token)}/trace`);
  }

  /** `GET /v1/shares/:token/events`: snapshot, or incremental when `after` is given. Capped at the share's snapshot cursor in `'snapshot'` mode. */
  events(after?: number): Promise<ActivityFrame> {
    return this.getJson<ActivityFrame>(`/v1/shares/${encodeURIComponent(this.token)}/events`, { after });
  }

  /** The `preview.png` URL for this share (whether or not one has been uploaded -- callers that need to know should check `meta()`/a `ShareSummary.preview` instead of fetching this speculatively). */
  previewUrl(): string {
    return this.buildUrl(`/v1/shares/${encodeURIComponent(this.token)}/preview.png`).toString();
  }

  /**
   * `WS /v1/shares/:token/live`. Only meaningful for a `mode: 'live'` share
   * (the hub closes the socket immediately otherwise, docs/SHARING.md); a
   * caller normally checks `meta().mode` first. Same reconnect-with-backoff
   * behaviour as `HubClient.live` (they share `./live-connect.js`).
   */
  live(onFrame: (frame: ActivityFrame) => void, liveOptions: LiveConnectOptions = {}): LiveDisposer {
    if (typeof this.WebSocketImpl !== 'function') {
      throw new Error('ShareClient.live: no WebSocket implementation available; pass { WebSocket }');
    }
    const urlFor = (cursor: number | undefined): string =>
      this.buildUrl(`/v1/shares/${encodeURIComponent(this.token)}/live`, { after: cursor })
        .toString()
        .replace(/^http/, 'ws');
    return connectLive(this.WebSocketImpl, urlFor, undefined, onFrame, liveOptions);
  }
}

// Re-exported so a caller of ShareClient rarely needs a separate import for
// its own read events (parity with StoredEvent's use elsewhere in this SDK).
export type { StoredEvent };
