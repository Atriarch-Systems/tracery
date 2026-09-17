/**
 * Framework-free engine behind `useHubSource` (SPEC.md §4): owns the
 * WebSocket, the poll timer, and the pure `feed.ts` state machine, so the
 * React hook only has to wire React state to a handful of callbacks. Pulled
 * out of the hook so this logic -- in particular the socket-failure counting
 * and the poll-vs-offline decision -- is unit-testable without a DOM
 * (`node --test`, no jsdom), and so nothing here performs side effects from
 * inside a React state updater (an earlier version called `disposeLive()`/
 * `startPolling()` from within a `setFeed` updater function, which React may
 * invoke more than once -- StrictMode double-invokes, or a discarded and
 * replayed update -- so a pure updater must never do that).
 */
import { HubClient, type ActivityFrame, type StoredEvent } from '@atriarch/tracery-client';
import { feedReducer, initialFeedState, shouldPoll, type FeedState } from './feed.js';

export interface HubFeedEngineOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly workspace?: string;
  /** Scope the live feed and the polling fallback to one flow. */
  readonly flow?: string;
  /** Scope the live feed to one trace. The polling fallback refetches the whole trace each tick (no `after` on that endpoint, SPEC.md §6). */
  readonly trace?: string;
  readonly pollIntervalMs: number;
  readonly fetch?: typeof fetch;
  readonly WebSocket?: typeof WebSocket;
  /** Called for every frame applied, live or polled. */
  readonly onFrame: (frame: ActivityFrame) => void;
  /** Called whenever the feed's connection state changes. */
  readonly onFeed: (state: FeedState) => void;
  /** Called with a poll failure's message, or `undefined` once a subsequent poll succeeds. */
  readonly onError: (message: string | undefined) => void;
}

export interface HubFeedEngine {
  /** Tears down the socket and/or poll timer. Idempotent. */
  dispose(): void;
}

/**
 * Wraps a WebSocket constructor so each socket instance reports at most one
 * drop to `onDrop`, no matter how many of `close`/`error` actually fire on
 * it. Per the WHATWG spec, "fail the WebSocket connection" dispatches an
 * `error` event and *then* a `close` event on the same socket, so listening
 * for both without this guard double-counts a single abrupt failure.
 */
export function instrumentedWebSocket(RealWebSocket: typeof WebSocket, onDrop: () => void): typeof WebSocket {
  return class InstrumentedWebSocket extends RealWebSocket {
    private dropped = false;
    constructor(url: string | URL, protocols?: string | readonly string[]) {
      super(url, protocols as string | string[] | undefined);
      const handleDrop = (): void => {
        if (this.dropped) return;
        this.dropped = true;
        onDrop();
      };
      this.addEventListener('close', handleDrop);
      this.addEventListener('error', handleDrop);
    }
  } as unknown as typeof WebSocket;
}

/** Starts the live feed (WS, falling back to polling) described by `options`; returns a disposer. */
export function startHubFeed(options: HubFeedEngineOptions): HubFeedEngine {
  const { baseUrl, apiKey, workspace, flow, trace, pollIntervalMs, fetch: fetchImpl, onFrame, onFeed, onError } = options;
  // Whether there is anything for the polling fallback to fetch at all
  // (SPEC.md §6 has no workspace-wide `after=` endpoint).
  const canPoll = flow !== undefined || trace !== undefined;

  let disposed = false;
  let feedState = initialFeedState();
  let disposeLive: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let cursor: number | undefined;

  const applyFeed = (next: FeedState): void => {
    feedState = next;
    onFeed(next);
  };

  const goOffline = (): void => {
    // No single flow or trace to poll SPEC.md §6's endpoints against once
    // the socket is gone: say so plainly rather than claiming a `polling`
    // status that describes a timer which will never fetch anything again.
    applyFeed({ ...feedState, status: 'offline' });
  };

  const startPolling = (): void => {
    if (pollTimer !== undefined || disposed) return;
    if (!canPoll) {
      goOffline();
      return;
    }
    pollTimer = setInterval(() => {
      void (async () => {
        try {
          let frame: ActivityFrame;
          if (flow) {
            frame = await client.events(flow, cursor);
          } else {
            // `canPoll` guarantees `trace` is set when `flow` is not.
            const events: readonly StoredEvent[] = await client.traceEvents(trace!);
            const maxCursor = events.reduce((max, e) => Math.max(max, e.cursor), cursor ?? 0);
            frame = { type: 'snapshot', cursor: maxCursor, events, truncated: false };
          }
          if (disposed) return;
          cursor = frame.cursor;
          onFrame(frame);
          onError(undefined);
          applyFeed(feedReducer(feedState, { type: 'poll-ok', frame }));
        } catch (err) {
          if (disposed) return;
          onError(err instanceof Error ? err.message : String(err));
          applyFeed(feedReducer(feedState, { type: 'poll-error' }));
        }
      })();
    }, pollIntervalMs);
  };

  const onSocketDrop = (): void => {
    if (disposed) return;
    const wasPolling = shouldPoll(feedState);
    applyFeed(feedReducer(feedState, { type: 'disconnect' }));
    if (shouldPoll(feedState) && !wasPolling) {
      disposeLive?.();
      disposeLive = undefined;
      startPolling();
    }
  };

  const RealWebSocket = options.WebSocket ?? (typeof WebSocket === 'function' ? WebSocket : undefined);
  const client = new HubClient({
    baseUrl,
    apiKey,
    workspace,
    fetch: fetchImpl,
    WebSocket: typeof RealWebSocket === 'function' ? instrumentedWebSocket(RealWebSocket, onSocketDrop) : undefined,
  });

  if (typeof RealWebSocket === 'function') {
    disposeLive = client.live({ flow, trace }, (frame) => {
      cursor = frame.cursor;
      onFrame(frame);
      applyFeed(feedReducer(feedState, { type: 'frame', frame }));
    });
  } else {
    // No WebSocket available at all (SSR, or a Node host with none provided): go straight to polling.
    startPolling();
  }

  return {
    dispose(): void {
      disposed = true;
      disposeLive?.();
      if (pollTimer !== undefined) clearInterval(pollTimer);
    },
  };
}
