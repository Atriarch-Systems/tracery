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
   * heartbeat frame. On disconnect, reconnects with exponential backoff
   * (capped at 10s) using `after=<last cursor seen>` so the resumed feed
   * never repeats or loses events. Returns a disposer that stops
   * reconnecting and closes the socket.
   */
  live(filter: LiveFilter, onFrame: (frame: ActivityFrame) => void): LiveDisposer {
    if (typeof this.WebSocketImpl !== 'function') {
      throw new Error('HubClient.live: no WebSocket implementation available; pass { WebSocket }');
    }
    // Narrowed once here; captured as a definite (non-undefined) constructor
    // so the nested `connect` function below does not need to re-check it.
    const WebSocketImpl: typeof WebSocket = this.WebSocketImpl;

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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

    const scheduleReconnect = (): void => {
      if (disposed) return;
      const delay = Math.min(200 * 2 ** attempt, 10_000);
      attempt++;
      reconnectTimer = setTimeout(connect, delay);
    };

    function connect(): void {
      if (disposed) return;
      const ws = new WebSocketImpl(socketUrl());
      socket = ws;
      ws.addEventListener('open', () => {
        attempt = 0;
      });
      ws.addEventListener('message', (event: MessageEvent) => {
        try {
          const frame = JSON.parse(String(event.data)) as ActivityFrame;
          cursor = frame.cursor;
          onFrame(frame);
        } catch {
          // malformed frame; ignore and keep the connection open
        }
      });
      ws.addEventListener('error', () => {
        // swallow; the 'close' event that follows drives reconnection
      });
      ws.addEventListener('close', scheduleReconnect);
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }
}
