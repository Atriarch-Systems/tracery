import type { ActivityFrame, StoredEvent } from '@atriarch/tracery-core';
import type { FlowSummary, ListFlowsQuery, ListFlowsResult, Trace } from './hub-types.stub.js';

export interface HubClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
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
export type LiveDisposer = () => void;

export interface LiveStatusEvent {
  readonly status: 'connecting' | 'open' | 'closed' | 'error';
  /** Reconnect attempts made since the backoff last reset (0 on the very first connect). */
  readonly attempt: number;
}

export interface LiveOptions {
  /** Called on every connecting/open/closed/error transition, so a caller can tell "connected and quiet" from "reconnect-looping on a bad key". */
  readonly onStatus?: (event: LiveStatusEvent) => void;
  /** Called with a malformed-frame parse error, or an error `onFrame` itself threw (frames are otherwise never re-delivered after a handler throws). */
  readonly onError?: (error: unknown) => void;
  /** Stop reconnecting after this many consecutive failed attempts. Default: unlimited. */
  readonly maxAttempts?: number;
  /** How long a connection must stay open before a later close resets the backoff to its floor, rather than continuing to climb. Default 1000ms. */
  readonly stableAfterMs?: number;
}

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
    this.apiKey = options.apiKey;
    this.workspace = options.workspace;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
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
    const res = await this.fetchImpl(this.buildUrl(path, query), {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
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
    // Narrowed once here; captured as a definite (non-undefined) constructor
    // so the nested `connect` function below does not need to re-check it.
    const WebSocketImpl: typeof WebSocket = this.WebSocketImpl;
    const { onStatus, onError, maxAttempts, stableAfterMs = 1000 } = liveOptions;

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let cursor = filter.after;

    const socketUrl = (): string => {
      const url = this.buildUrl('/v1/live', {
        flow: filter.flow,
        trace: filter.trace,
        after: cursor,
        token: this.apiKey,
      });
      return url.toString().replace(/^http/, 'ws');
    };

    const clearStableTimer = (): void => {
      if (stableTimer !== null) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
    };

    const scheduleReconnect = (): void => {
      clearStableTimer();
      onStatus?.({ status: 'closed', attempt });
      if (disposed) return;
      if (maxAttempts !== undefined && attempt >= maxAttempts) return;
      const capped = Math.min(200 * 2 ** attempt, 10_000);
      // Full jitter: many clients reconnecting after the same hub restart
      // should not all retry in lockstep.
      const delay = Math.random() * capped;
      attempt++;
      reconnectTimer = setTimeout(connect, delay);
    };

    function connect(): void {
      if (disposed) return;
      onStatus?.({ status: 'connecting', attempt });
      const ws = new WebSocketImpl(socketUrl());
      socket = ws;
      ws.addEventListener('open', () => {
        onStatus?.({ status: 'open', attempt });
        // Reset the backoff only once the connection has proven itself by
        // staying open a while, not immediately on `open` — see the doc
        // comment above.
        clearStableTimer();
        stableTimer = setTimeout(() => {
          attempt = 0;
          stableTimer = null;
        }, stableAfterMs);
      });
      ws.addEventListener('message', (event: MessageEvent) => {
        let frame: ActivityFrame;
        try {
          frame = JSON.parse(String(event.data)) as ActivityFrame;
        } catch (err) {
          onError?.(err); // malformed frame; ignore and keep the connection open
          return;
        }
        try {
          // Advance the cursor only once the frame has actually been handed
          // off: if the consumer's own handler throws, the frame is not
          // marked seen, so a reconnect will replay it instead of leaving a
          // silent, permanent gap in the feed.
          onFrame(frame);
          cursor = frame.cursor;
        } catch (err) {
          onError?.(err);
        }
      });
      ws.addEventListener('error', (event) => {
        onError?.(event);
        // the 'close' event that follows drives reconnection
      });
      ws.addEventListener('close', scheduleReconnect);
    }

    connect();

    return () => {
      disposed = true;
      clearStableTimer();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }
}
