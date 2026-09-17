/**
 * The shape both `useJournalSource` and `useHubSource` return, and what
 * `ActivityExplorer` and `useProjection` consume (SPEC.md §4). A source is a
 * live view of the flows known so far plus enough connection state to render
 * a status indicator; it never exposes the transport (Journal, HubClient) itself.
 */
import type { Flow } from '@atriarch/tracery-core';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline';

export interface ActivitySource {
  /** Every flow reduced so far, keyed by flow id. */
  readonly flows: ReadonlyMap<string, Flow>;
  readonly status: ConnectionStatus;
  /** Hub cursor of the last applied frame; undefined for a journal source or before the first frame. */
  readonly cursor?: number;
  /** True once history has been evicted (journal) or a reconnect returned a truncated snapshot (hub). */
  readonly partial: boolean;
  readonly error?: string;
}
