# @atriarch/activity-react

`ActivityExplorer`: a composite React explorer (connection status, flow
picker, guided activity graph, inspector, group legend) plus the hooks that
feed it. Built on `@atriarch/activity-core` (reducers, projection) and
`@atriarch/activity-visualizer` (the canvas). See
[`../../docs/SPEC.md`](../../docs/SPEC.md) §4 for the full contract; this
README is a usage guide.

```
npm install @atriarch/activity-react
```

## Embedding: point it at a hub

```tsx
import { ActivityExplorer, useHubSource } from '@atriarch/activity-react';

function MyPage() {
  const source = useHubSource({
    baseUrl: 'https://activity.example.com',
    apiKey: 'read-key-for-my-workspace',
    workspace: 'default',
  });

  return (
    <div style={{ height: '100vh' }}>
      <ActivityExplorer source={source} />
    </div>
  );
}
```

`useHubSource` opens `WS /v1/live` (via `@atriarch/activity-client`'s
`HubClient`, which already resumes from the last cursor it saw with
exponential backoff) and reduces every frame into `Flow`s with
`@atriarch/activity-core`. If the socket keeps failing -- two consecutive
close/error events -- it falls back to polling `GET
/v1/flows/:id/events?after=` (or, scoped to a trace with no single flow,
`GET /v1/traces/:id/events`, a full refetch each tick since that endpoint has
no `after` parameter). Pass `flow` or `trace` to scope the whole source to
one flow or trace instead of the workspace.

## Embedding: point it at your own in-process journal

```tsx
import { useMemo } from 'react';
import { Journal } from '@atriarch/activity-core';
import { ActivityExplorer, useJournalSource } from '@atriarch/activity-react';

function MyPage() {
  const journal = useMemo(() => new Journal({ maxEvents: 20_000 }), []);
  // ... elsewhere: journal.append(events) as your app produces them ...
  const source = useJournalSource(journal);

  return (
    <div style={{ height: '100vh' }}>
      <ActivityExplorer source={source} />
    </div>
  );
}
```

`useJournalSource` re-derives `Flow`s from the journal on a light poll
(default 250ms) since `Journal` has no change notification of its own. It
always computes its first render synchronously, so a journal that is already
populated (for example, `@atriarch/activity-core/fixtures`'
`sampleTraceEvents`) renders correctly on the very first pass -- including
under `react-dom/server`.

## `ActivityExplorer` props

```ts
interface ActivityExplorerProps {
  source: ActivitySource;                 // from useHubSource or useJournalSource
  initialScope?: Scope;                   // { mode: 'flow' | 'ancestors', flow } | { mode: 'trace', trace }
  catalog?: (node: NodeRecord, flow: Flow) => NodePresentation;
  renderInspector?: (selection: InspectorSelection | null) => ReactNode;
  theme?: { bg?; fg?; accent?; muted?; error? };   // sets the --activity-* CSS variables
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}
```

- **Connection status** is a dot + label (`connecting` / `live` /
  `reconnecting` / `polling` / `offline`), `data-testid="connection-status"`.
- **Flow picker** lists flows newest-first with active (`status: 'running'`)
  flows pinned to the top (`orderFlows`/`latestFlows`, exported from
  `./flow-order.js`). "Follow latest" (a checkbox, on by default) keeps the
  explorer's active flow pinned to whichever flow that ordering puts first;
  picking a flow from the list, a deep-linked `initialScope`, or activating a
  node in a different flow's group all turn it off.
- **Scope switch**: This flow / With ancestors / Whole trace
  (`data-testid="scope-flow"` / `scope-ancestors` / `scope-trace`), also
  bound to keys `1`/`2`/`3` while the explorer has focus.
- **Graph**: `ActivityGraph` in `layoutMode="guided"` via `placeBranches`, so
  spawned subgraphs grow beside their spawner and re-render with stable
  positions. In trace scope, a **group legend** lists each flow
  (`data-testid="group-legend-item"`, one per `FlowGroup`); clicking a legend
  item jumps the active flow there.
- Because the graph itself is canvas-drawn, each group also gets a small
  accessible node list (`data-testid="node-item"`) alongside it: the same
  click-to-select / double-click-to-drill-in affordance as the canvas cards,
  reachable by keyboard and by automated tests without canvas hit-testing.
- **Activating a node** that belongs to a different flow's group -- by
  double-clicking its canvas card (`onNodeActivate`, also fires on `Enter`
  while a node is selected), double-clicking its entry in the accessible
  node list, or double-clicking a group legend item -- drills the explorer
  into that flow (`{ mode: 'flow', flow }`).
- **Inspector**: the selected node's ops newest-first, each with status,
  timing, `durationMs`, tags, a collapsible pretty-printed JSON view of the
  op's merged context, and its `annotate` timeline entries. Override the
  whole panel with `renderInspector`.
- **Styling** is inline objects reading `var(--activity-bg|fg|accent|muted|error, <dark default>)`;
  no Tailwind, no stylesheet. Pass `theme` to set those variables on the
  explorer's root element, or set them yourself further up the DOM tree.

## Hooks

```ts
useJournalSource(journal: Journal, options?: { pollIntervalMs?: number }): ActivitySource
useHubSource(options: { baseUrl; apiKey; workspace?; flow?; trace?; maxEvents?; pollIntervalMs?; fetch?; WebSocket? }): ActivitySource
useProjection(source: ActivitySource, scope: Scope, options?: { catalog?; now?; history? }): Projection
```

`ActivitySource` is the shape both source hooks return and what
`ActivityExplorer`/`useProjection` consume:

```ts
interface ActivitySource {
  flows: ReadonlyMap<string, Flow>;
  status: 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline';
  cursor?: number;
  partial: boolean;   // journal eviction, or a truncated hub snapshot
  error?: string;
}
```

## The feed state machine

`useHubSource`'s WebSocket-vs-polling decision is a pure reducer,
`./feed.js`, kept free of any socket/timer/DOM code specifically so it is
testable without a browser (`tests/feed.test.mjs`):

```ts
import { feedReducer, initialFeedState, reconnectAfter, shouldPoll } from '@atriarch/activity-react';

let state = initialFeedState();
state = feedReducer(state, { type: 'frame', frame: someSnapshotFrame });   // -> live
state = feedReducer(state, { type: 'disconnect' });                       // -> reconnecting (1st failure)
state = feedReducer(state, { type: 'disconnect' });                       // -> polling (2nd failure)
shouldPoll(state);       // true
reconnectAfter(state);   // cursor to resume from
```

`useHubSource` itself owns the actual `WebSocket` (via
`@atriarch/activity-client`'s `HubClient.live`, wrapped to count
close/error events) and the poll `setInterval`; the reducer only ever sees
`frame` / `disconnect` / `poll-ok` / `poll-error` / `reset` actions.

## Scope helpers

`./scope.js` derives the `Scope` `project()` wants from the explorer's
(mode, active flow) state, and decides what activating a node should do --
both pure and exported for reuse:

```ts
import { computeScope, activatedFlow, scopeModeForKey } from '@atriarch/activity-react';

computeScope('trace', 'flow:research-1', flows);   // -> { mode: 'trace', trace: <resolved trace id> }
scopeModeForKey('3');                               // -> 'trace'
activatedFlow(node, 'flow:parent');                 // -> 'flow:research-1' when node.data.flow differs, else null
```

## Development

```
npm run build   # tsc -p tsconfig.json
npm test        # node --test tests/*.test.mjs (runs against dist/, build first)
```

Tests cover: `react-dom/server` rendering `ActivityExplorer` (via
`useJournalSource` with `@atriarch/activity-core/fixtures`' sample trace)
without throwing, including its flow labels; the feed reducer's full state
machine (snapshot, events, heartbeat, disconnect, reconnect cursor, stale
snapshot -> `truncated`, fallback to polling after two failures, recovery);
`computeScope` in all three modes and `activatedFlow`'s child-group-activate
rule; and flow-picker ordering (`orderFlows`/`latestFlows`/`latestFlowId`).

See [`../../apps/hub/web`](../../apps/hub/web) for the hosted UI that embeds
this package against a running hub, including a Playwright suite that
exercises the same flow-list / trace-scope / inspector / drill-in behavior
end to end.
