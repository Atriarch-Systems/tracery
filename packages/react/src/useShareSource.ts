/**
 * Live view of one share link (docs/SHARING.md), for `ActivityExplorer`'s
 * share mode: `<ActivityExplorer source={useShareSource(baseUrl, token)}
 * readOnly lockedTarget={source.target && { type: source.target.type, id:
 * source.target.id }} />`. No API key, ever -- the token is the only
 * credential (`@atriarch/tracery-client`'s `ShareClient`).
 *
 * Fetches `GET .../meta` once to learn the share's target/mode/label, then
 * hands the rest to `./share-feed-engine.js`: a `'snapshot'` share gets one
 * `GET .../events` fetch (it can never change -- every read is capped at
 * creation time); a `'live'` share opens `WS .../live` (falling back to
 * polling `GET .../events?after=`, same as `useHubSource`).
 */
import { useEffect, useState } from 'react';
import { ShareClient, type ActivityFrame } from '@atriarch/tracery-client';
import { Journal, buildFlows, type Flow } from '@atriarch/tracery-core';
import { initialFeedState, type FeedState } from './feed.js';
import { startShareFeed } from './share-feed-engine.js';
import type { ActivitySource } from './source.js';

export interface UseShareSourceOptions {
  readonly maxEvents?: number;
  /** Polling fallback interval once a live share's socket has failed twice. Default 4000ms. */
  readonly pollIntervalMs?: number;
  readonly fetch?: typeof fetch;
  readonly WebSocket?: typeof WebSocket;
}

export interface ShareTargetInfo {
  readonly type: 'flow' | 'trace';
  readonly id: string;
}

export interface ShareSource extends ActivitySource {
  /** The share's declared target -- feed straight into `ActivityExplorer`'s `lockedTarget` prop. `undefined` until `GET .../meta` resolves. */
  readonly target?: ShareTargetInfo;
  readonly mode?: 'snapshot' | 'live';
  readonly label?: string;
  /** Whether the sharer chose to include producer context. `false` (or a redacted context showing up in the data regardless) drives `ActivityExplorer`'s "Context hidden by the sharer" notice. */
  readonly includeContext?: boolean;
  /** Set once when `GET .../meta` 404s (unknown, expired or revoked token) -- distinct from a transient `error`, since retrying never helps. */
  readonly notFound: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 4000;

export function useShareSource(baseUrl: string, token: string, options: UseShareSourceOptions = {}): ShareSource {
  const { maxEvents, fetch: fetchImpl, WebSocket: wsImpl } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const [feed, setFeed] = useState<FeedState>(() => initialFeedState());
  const [flows, setFlows] = useState<ReadonlyMap<string, Flow>>(() => new Map());
  const [error, setError] = useState<string | undefined>(undefined);
  const [notFound, setNotFound] = useState(false);
  const [target, setTarget] = useState<ShareTargetInfo | undefined>(undefined);
  const [mode, setMode] = useState<'snapshot' | 'live' | undefined>(undefined);
  const [label, setLabel] = useState<string | undefined>(undefined);
  const [includeContext, setIncludeContext] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let journal = new Journal({ maxEvents: maxEvents ?? 50_000 });
    let engine: { dispose(): void } | undefined;

    setFeed(initialFeedState());
    setFlows(new Map());
    setError(undefined);
    setNotFound(false);
    setTarget(undefined);
    setMode(undefined);
    setLabel(undefined);
    setIncludeContext(undefined);

    const recompute = (): void => {
      if (disposed) return;
      setFlows(buildFlows(journal.events()));
    };

    const metaClient = new ShareClient({ baseUrl, token, fetch: fetchImpl, WebSocket: wsImpl });
    void metaClient
      .meta()
      .then((meta) => {
        if (disposed) return;
        setTarget(meta.target);
        setMode(meta.mode);
        setLabel(meta.label);
        setIncludeContext(meta.includeContext);

        engine = startShareFeed({
          baseUrl,
          token,
          live: meta.mode === 'live',
          pollIntervalMs,
          fetch: fetchImpl,
          WebSocket: wsImpl,
          onFrame: (frame: ActivityFrame) => {
            if (disposed) return;
            if (frame.type === 'snapshot' && frame.truncated) {
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
      })
      .catch((err: unknown) => {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        if (/\b404\b|no such share/i.test(message)) setNotFound(true);
        setError(message);
        setFeed({ ...initialFeedState(), status: 'offline' });
      });

    return () => {
      disposed = true;
      engine?.dispose();
    };
  }, [baseUrl, token, maxEvents, pollIntervalMs, fetchImpl, wsImpl]);

  return { flows, status: feed.status, cursor: feed.cursor, partial: feed.truncated, error, notFound, target, mode, label, includeContext };
}
