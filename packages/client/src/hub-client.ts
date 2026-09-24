import type { ActivityFrame, StoredEvent } from '@atriarch-systems/tracery-core';
import type { FlowSummary, ListFlowsQuery, ListFlowsResult, Trace } from './hub-types.stub.js';
import { connectLive, type LiveConnectOptions, type LiveDisposer as LiveConnectDisposer, type LiveStatusEvent as LiveConnectStatusEvent } from './live-connect.js';
import type { ShareMode, ShareTarget, ShareSummary, CreateShareOptions, CreateShareResult } from './share-types.js';

export interface HubClientOptions {
  readonly baseUrl: string;
  /** Omit (or pass `''`) against a hub running in local mode (`authMode: 'none'`, task: "local mode") -- no `Authorization` header or `?token=` is sent at all. */
  readonly apiKey?: string;
  readonly workspace?: string;
  readonly fetch?: typeof fetch;
  readonly WebSocket?: typeof WebSocket;
}

export interface LiveFilter {
  readonly flow?: string;
  readonly trace?: string;
  /** Hub cursor to resume from; omit to start from a fresh snapshot. */
  readonly after?: number;
}

/** Stops reconnecting and closes the live socket. */
export type LiveDisposer = LiveConnectDisposer;

export type LiveStatusEvent = LiveConnectStatusEvent;

/** Same shape as `./live-connect.js`'s `LiveConnectOptions` -- kept as its own exported name since it predates that extraction. */
export type LiveOptions = LiveConnectOptions;

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

type QueryValue = string | number | undefined;

/** Read-side client for the hub's HTTP + WebSocket API (SPEC §6). */
export class HubClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly workspace?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl?: typeof WebSocket;

  constructor(options: HubClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? '';
    this.workspace = options.workspace;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.WebSocketImpl = options.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('HubClient: no fetch implementation available; pass { fetch }');
    }
  }

  private buildUrl(path: string, query?: Readonly<Record<string, QueryValue>>): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    if (this.workspace !== undefined) url.searchParams.set('workspace', this.workspace);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  private async getJson<T>(path: string, query?: Readonly<Record<string, QueryValue>>): Promise<T> {
    // Local mode (task: "local mode", `authMode: 'none'`) needs no
    // credential at all -- omit the header entirely rather than send an
    // empty `Bearer `, which some HTTP stacks strip anyway but a fetch
    // proxy/logger might otherwise capture as if it were a real key attempt.
    const headers: Record<string, string> = this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
    const res = await this.fetchImpl(this.buildUrl(path, query), { headers });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as ErrorBody;
        if (body.error?.message) message = body.error.message;
      } catch {
        // response body wasn't JSON; keep the status-line message
      }
      throw new Error(`HubClient request to ${path} failed: ${message}`);
    }
    return (await res.json()) as T;
  }

  /** `GET /v1/flows`: newest-first flow list. */
  listFlows(query: ListFlowsQuery = {}): Promise<ListFlowsResult> {
    return this.getJson<ListFlowsResult>('/v1/flows', {
      limit: query.limit,
      before: query.before,
      status: query.status,
      actor: query.actor,
      trace: query.trace,
      q: query.q,
    });
  }

  /** `GET /v1/flows/:id`: flow summary with node/edge records, no events. */
  getFlow(id: string): Promise<FlowSummary> {
    return this.getJson<FlowSummary>(`/v1/flows/${encodeURIComponent(id)}`);
  }

  /** `GET /v1/traces/:id`: the trace with all member flows. */
  getTrace(id: string): Promise<Trace> {
    return this.getJson<Trace>(`/v1/traces/${encodeURIComponent(id)}`);
  }

  /** `GET /v1/flows/:id/events`: snapshot, or incremental when `after` is given. */
  events(flow: string, after?: number): Promise<ActivityFrame> {
    return this.getJson<ActivityFrame>(`/v1/flows/${encodeURIComponent(flow)}/events`, { after });
  }

  /** `GET /v1/traces/:id/events`: every event for every flow in the trace. */
  traceEvents(trace: string): Promise<readonly StoredEvent[]> {
    return this.getJson<readonly StoredEvent[]>(`/v1/traces/${encodeURIComponent(trace)}/events`);
  }

  /**
   * Subscribe to `WS /v1/live`. Calls `onFrame` for every snapshot/events/
   * heartbeat frame. On disconnect, reconnects with capped, jittered
   * exponential backoff using `after=<last cursor seen>` so the resumed feed
   * never repeats or loses events. The backoff only resets to its floor once
   * a connection has stayed open past `stableAfterMs`, so a hub that
   * completes the upgrade and then immediately closes (a rejected key,
   * load-shedding, a slow-client drop) backs off instead of reconnecting
   * forever at the 200ms floor. Returns a disposer that stops reconnecting
   * and closes the socket.
   */
  live(filter: LiveFilter, onFrame: (frame: ActivityFrame) => void, liveOptions: LiveOptions = {}): LiveDisposer {
    if (typeof this.WebSocketImpl !== 'function') {
      throw new Error('HubClient.live: no WebSocket implementation available; pass { WebSocket }');
    }
    const urlFor = (cursor: number | undefined): string =>
      this.buildUrl('/v1/live', {
        flow: filter.flow,
        trace: filter.trace,
        after: cursor,
        // Omitted entirely (not sent as `token=`) in local mode -- `buildUrl`
        // already skips `undefined` query values.
        token: this.apiKey || undefined,
      })
        .toString()
        .replace(/^http/, 'ws');
    return connectLive(this.WebSocketImpl, urlFor, filter.after, onFrame, liveOptions);
  }

  private async request(method: string, path: string, query?: Readonly<Record<string, QueryValue>>, jsonBody?: unknown): Promise<Response> {
    const headers: Record<string, string> = this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
    let body: string | undefined;
    if (jsonBody !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(jsonBody);
    }
    const res = await this.fetchImpl(this.buildUrl(path, query), { method, headers, body });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const errBody = (await res.json()) as ErrorBody;
        if (errBody.error?.message) message = errBody.error.message;
      } catch {
        // response body wasn't JSON; keep the status-line message
      }
      throw new Error(`HubClient request to ${path} failed: ${message}`);
    }
    return res;
  }

  /** `POST/GET/DELETE/PUT /v1/shares*` (docs/SHARING.md): create, list and revoke share links, and upload a preview image. */
  readonly shares: HubClientShares = {
    create: async (options: CreateShareOptions): Promise<CreateShareResult> => {
      const res = await this.request('POST', '/v1/shares', undefined, {
        target: options.target,
        mode: options.mode,
        includeContext: options.includeContext,
        expiresInDays: options.expiresInDays,
      });
      return (await res.json()) as CreateShareResult;
    },
    list: async (): Promise<readonly ShareSummary[]> => {
      const res = await this.request('GET', '/v1/shares');
      const body = (await res.json()) as { shares: readonly ShareSummary[] };
      return body.shares;
    },
    revoke: async (id: string): Promise<void> => {
      await this.request('DELETE', `/v1/shares/${encodeURIComponent(id)}`);
    },
    uploadPreview: async (id: string, png: Uint8Array): Promise<void> => {
      const headers: Record<string, string> = { 'content-type': 'image/png' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const res = await this.fetchImpl(this.buildUrl(`/v1/shares/${encodeURIComponent(id)}/preview`), {
        method: 'PUT',
        headers,
        // Cast: @types/node's ambient `Uint8Array<ArrayBufferLike>` and lib.dom's
        // `BodyInit` disagree structurally even though every runtime (browser
        // fetch, undici) accepts a Uint8Array body just fine.
        body: png as unknown as BodyInit,
      });
      if (!res.ok) {
        let message = `${res.status} ${res.statusText}`;
        try {
          const errBody = (await res.json()) as ErrorBody;
          if (errBody.error?.message) message = errBody.error.message;
        } catch {
          // ignore
        }
        throw new Error(`HubClient.shares.uploadPreview failed: ${message}`);
      }
    },
  };
}

export interface HubClientShares {
  create(options: CreateShareOptions): Promise<CreateShareResult>;
  list(): Promise<readonly ShareSummary[]>;
  revoke(id: string): Promise<void>;
  uploadPreview(id: string, png: Uint8Array): Promise<void>;
}

export type { ShareMode, ShareTarget, ShareTargetType, ShareSummary, CreateShareOptions, CreateShareResult } from './share-types.js';
