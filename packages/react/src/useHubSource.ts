/**
 * Live source backed by the hub's HTTP + WebSocket API (SPEC.md §4
 * `useHubSource({ baseUrl, workspace, apiKey, flow?, trace? })`). Delegates
 * the actual reconnect-with-backoff to `HubClient.live` (workstream C,
 * `packages/client/src/hub-client.ts`), which already resumes from the last
 * cursor it saw; this hook layers on top of it the one thing `HubClient`
 * does not do -- counting consecutive socket failures and, once the feed's
 * pure state machine (`./feed.ts`) says to, tearing the socket down and
 * switching to polling `GET /v1/flows/:id/events?after=` (or, for a
 * trace-scoped source with no single flow, `GET /v1/traces/:id/events`, full
 * refetch every tick since that endpoint has no `after` parameter in SPEC.md §6).
 *
 * Every applied frame (live or polled) is appended to an internal `Journal`
 * and reduced with `buildFlows`, so the returned `ActivitySource.flows` is
 * always a plain, already-deduplicated `Flow` map regardless of which path
 * delivered the events.
 */
import { useEffect, useState } from 'react';
import { HubClient, type ActivityFrame, type StoredEvent } from '@atriarch/activity-client';
import { Journal, buildFlows, type Flow } from '@atriarch/activity-core';
import { feedReducer, initialFeedState, shouldPoll, type FeedState } from './feed.js';
import type { ActivitySource } from './source.js';

export interface UseHubSourceOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly workspace?: string;
  /** Scope the live feed and polling fallback to one flow. */
  readonly flow?: string;
  /** Scope the live feed to one trace. Polling fallback (no single flow given) refetches the whole trace each tick. */
  readonly trace?: string;
  readonly maxEvents?: number;
  /** Polling fallback interval once the socket has failed twice. Default 4000ms. */
  readonly pollIntervalMs?: number;
  readonly fetch?: typeof fetch;
  readonly WebSocket?: typeof WebSocket;
}

const DEFAULT_POLL_INTERVAL_MS = 4000;

/** Wraps a WebSocket constructor so every socket it creates reports its own close/error back to `onDrop`. */
function instrumentedWebSocket(RealWebSocket: typeof WebSocket, onDrop: () => void): typeof WebSocket {
  return class InstrumentedWebSocket extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | readonly string[]) {
      super(url, protocols as string | string[] | undefined);
      this.addEventListener('close', onDrop);
      this.addEventListener('error', onDrop);
    }
  } as unknown as typeof WebSocket;
}

export function useHubSource(options: UseHubSourceOptions): ActivitySource {
  const { baseUrl, apiKey, workspace, flow, trace, maxEvents, fetch: fetchImpl, WebSocket: wsImpl } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const [feed, setFeed] = useState<FeedState>(() => initialFeedState());
  const [flows, setFlows] = useState<ReadonlyMap<string, Flow>>(() => new Map());
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let journal = new Journal({ maxEvents: maxEvents ?? 50_000 });
    let disposeLive: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let cursor: number | undefined;

    setFeed(initialFeedState());
    setFlows(new Map());
    setError(undefined);

    const recompute = (): void => {
      if (disposed) return;
      setFlows(buildFlows(journal.events()));
    };

    const applyFrame = (frame: ActivityFrame): void => {
      if (disposed) return;
      if (frame.type === 'snapshot' && frame.truncated) {
        // The store no longer holds `after=cursor`: the journal can't be
        // trusted to be contiguous with what follows, so start clean.
        journal = new Journal({ maxEvents: maxEvents ?? 50_000 });
      }
      if (frame.type !== 'heartbeat') journal.append(frame.events);
      cursor = frame.cursor;
      recompute();
    };

    const startPolling = (): void => {
      if (pollTimer !== undefined || disposed) return;
      pollTimer = setInterval(() => {
        void (async () => {
          try {
            let frame: ActivityFrame;
            if (flow) {
              frame = await client.events(flow, cursor);
            } else if (trace) {
              const events: readonly StoredEvent[] = await client.traceEvents(trace);
              const maxCursor = events.reduce((max, e) => Math.max(max, e.cursor), cursor ?? 0);
              frame = { type: 'snapshot', cursor: maxCursor, events, truncated: false };
            } else {
              // No single flow or trace to poll against SPEC.md §6's endpoints; nothing to fetch this tick.
              return;
            }
            if (disposed) return;
            applyFrame(frame);
            setFeed((s) => feedReducer(s, { type: 'poll-ok', frame }));
          } catch (err) {
            if (disposed) return;
            setError(err instanceof Error ? err.message : String(err));
            setFeed((s) => feedReducer(s, { type: 'poll-error' }));
          }
        })();
      }, pollIntervalMs);
    };

    const onSocketDrop = (): void => {
      if (disposed) return;
      setFeed((s) => {
        const next = feedReducer(s, { type: 'disconnect' });
        if (shouldPoll(next) && !shouldPoll(s)) {
          disposeLive?.();
          disposeLive = undefined;
          startPolling();
        }
        return next;
      });
    };

    const RealWebSocket = wsImpl ?? (typeof WebSocket === 'function' ? WebSocket : undefined);
    // A fresh HubClient per effect run so the instrumented WebSocket
    // constructor (closed over this run's `onSocketDrop`) is the one
    // `HubClient.live` actually uses.
    const client = new HubClient({
      baseUrl,
      apiKey,
      workspace,
      fetch: fetchImpl,
      WebSocket: typeof RealWebSocket === 'function' ? instrumentedWebSocket(RealWebSocket, onSocketDrop) : undefined,
    });

    if (typeof RealWebSocket === 'function') {
      disposeLive = client.live({ flow, trace }, (frame) => {
        applyFrame(frame);
        setFeed((s) => feedReducer(s, { type: 'frame', frame }));
      });
    } else {
      // No WebSocket available at all (SSR, or a Node host with none
      // provided): go straight to polling.
      startPolling();
    }

    return () => {
      disposed = true;
      disposeLive?.();
      if (pollTimer !== undefined) clearInterval(pollTimer);
    };
  }, [baseUrl, apiKey, workspace, flow, trace, maxEvents, pollIntervalMs, fetchImpl, wsImpl]);

  return { flows, status: feed.status, cursor: feed.cursor, partial: feed.truncated, error };
}
