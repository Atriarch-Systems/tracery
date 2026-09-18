export { ActivityExplorer } from './ActivityExplorer.js';
export type { ActivityExplorerProps, LockedTarget } from './ActivityExplorer.js';

// Re-exported so a host page (docs/SHARING.md "Image export": a "Download
// image" button calling `graphRef.current?.toImage()`) does not need its own
// direct dependency on @atriarch/tracery-visualizer just for this one type.
export type { ActivityGraphHandle } from '@atriarch/tracery-visualizer';

export { Inspector } from './Inspector.js';
export type { InspectorSelection } from './Inspector.js';

export { isRedactedContext } from './redacted.js';
export type { RedactedContextShape } from './redacted.js';

export { useJournalSource } from './useJournalSource.js';
export type { UseJournalSourceOptions } from './useJournalSource.js';

export { useHubSource } from './useHubSource.js';
export type { UseHubSourceOptions } from './useHubSource.js';

export { useShareSource } from './useShareSource.js';
export type { UseShareSourceOptions, ShareSource, ShareTargetInfo } from './useShareSource.js';

export { useProjection } from './useProjection.js';
export type { UseProjectionOptions } from './useProjection.js';

export type { ActivitySource, ConnectionStatus } from './source.js';

export {
  feedReducer,
  initialFeedState,
  reconnectAfter,
  shouldPoll,
  WS_FAILURES_BEFORE_POLLING,
} from './feed.js';
export type { FeedState, FeedAction, FeedStatus } from './feed.js';

export { orderFlows, latestFlows, latestFlowId } from './flow-order.js';

export {
  computeScope,
  scopeKey,
  scopeModeForKey,
  activatedFlow,
  isScopeShortcutTarget,
  SCOPE_LABELS,
  SCOPE_MODE_KEYS,
} from './scope.js';
export type { ScopeMode } from './scope.js';

export { rootStyle, styles } from './style.js';
export type { ActivityThemeVars } from './style.js';
