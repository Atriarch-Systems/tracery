/**
 * Live source backed by the hub's HTTP + WebSocket API (SPEC.md §4
 * `useHubSource({ baseUrl, workspace, apiKey, flow?, trace? })`). Delegates
 * the actual reconnect-with-backoff to `HubClient.live` (workstream C,
 * `packages/client/src/hub-client.ts`), which already resumes from the last
 * cursor it saw; the connection bookkeeping on top of that -- counting
 * consecutive socket failures, switching to polling once the feed's pure
 * state machine (`./feed.ts`) says to, or going `offline` when there is
 * nothing to poll -- lives in `./hub-feed-engine.ts`, a framework-free
 * engine this hook just wires up to React state. This hook owns only the
 * `Journal` that turns applied frames into `Flow`s.
 *
 * Every applied frame (live or polled) is appended to an internal `Journal`
 * and reduced with `buildFlows`, so the returned `ActivitySource.flows` is
 * always a plain, already-deduplicated `Flow` map regardless of which path
 * delivered the events.
 */
import { useEffect, useState } from 'react';
import type { ActivityFrame } from '@atriarch/tracery-client';
import { Journal, buildFlows, type Flow } from '@atriarch/tracery-core';
import { initialFeedState, type FeedState } from './feed.js';
import { startHubFeed } from './hub-feed-engine.js';
import type { ActivitySource } from './source.js';

export interface UseHubSourceOptions {
  readonly baseUrl: string;
  /** Omit against a hub running in local mode (`authMode: 'none'`, task: "local mode") -- no credential is sent at all. */
  readonly apiKey?: string;
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

export function useHubSource(options: UseHubSourceOptions): ActivitySource {
  const { baseUrl, apiKey, workspace, flow, trace, maxEvents, fetch: fetchImpl, WebSocket: wsImpl } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const [feed, setFeed] = useState<FeedState>(() => initialFeedState());
  const [flows, setFlows] = useState<ReadonlyMap<string, Flow>>(() => new Map());
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let journal = new Journal({ maxEvents: maxEvents ?? 50_000 });

    setFeed(initialFeedState());
    setFlows(new Map());
    setError(undefined);

    const recompute = (): void => {
      if (disposed) return;
      setFlows(buildFlows(journal.events()));
    };

    const engine = startHubFeed({
      baseUrl,
      // `HubFeedEngineOptions.apiKey` stays a required string (untouched by
      // this task's narrower "make apiKey optional" scope, which names only
      // this file and `hub-client.ts`) -- `HubClient` itself already treats
      // `''` as "no credential" (local mode, task: "local mode").
      apiKey: apiKey ?? '',
      workspace,
      flow,
      trace,
      pollIntervalMs,
      fetch: fetchImpl,
      WebSocket: wsImpl,
      onFrame: (frame: ActivityFrame) => {
        if (disposed) return;
        if (frame.type === 'snapshot' && frame.truncated) {
          // The store no longer holds `after=cursor`: the journal can't be
          // trusted to be contiguous with what follows, so start clean.
          journal = new Journal({ maxEvents: maxEvents ?? 50_000 });
        }
        if (frame.type !== 'heartbeat') journal.append(frame.events);
        recompute();
      },
      onFeed: (next) => {
        if (!disposed) setFeed(next);
      },
      onError: (message) => {
        if (!disposed) setError(message);
      },
    });

    return () => {
      disposed = true;
      engine.dispose();
    };
  }, [baseUrl, apiKey, workspace, flow, trace, maxEvents, pollIntervalMs, fetchImpl, wsImpl]);

  return { flows, status: feed.status, cursor: feed.cursor, partial: feed.truncated, error };
}
