# @atriarch/activity-visualizer

A React 18/19 component for live activity graphs. One generic node card, configured by the consumer. There are no agent names, node-kind registries, network connections, or invocation reducers in the library.

This is an independent npm package inside Agent Kit. It is not part of the Python wheel and does not add JavaScript dependencies to Python consumers.

```tsx
import { ActivityGraph, type ActivityNode, type ActivityEdge,
  type NodePresentation } from '@atriarch/activity-visualizer';

// This catalog belongs to the application, not Agent Kit.
const catalog = {
  input: { badge: 'SOURCE', icon: '↔' },
  worker: { badge: 'WORKER', icon: '✳', width: 152, height: 74, accent: '#adf17b' },
} satisfies Record<string, NodePresentation>;

const nodes: ActivityNode<{ operationId: string }>[] = [
  { id: 'source', label: 'Inbox', presentation: catalog.input,
    position: { x: -200, y: 0, anchored: true } },
  { id: 'worker', label: 'Research', detail: 'Reading sources',
    presentation: catalog.worker, status: 'running',
    activity: { highlighted: true }, data: { operationId: 'call-123' } },
];
const edges: ActivityEdge[] = [
  { id: 'source-worker', source: 'source', target: 'worker',
    label: 'invoke', count: 3, activity: { highlighted: true } },
];

<div style={{ height: 600 }}>
  <ActivityGraph nodes={nodes} edges={edges}
    onNodeSelect={node => console.log(node?.data)} />
</div>
```

## Ownership

The consumer owns its node catalog, stable IDs, domain events, aggregation/counts, request selection, retained history, error meanings and inspector content. It supplies readonly node and edge arrays. The visualizer owns canvas drawing, force layout, anchoring, selection feedback, animation and camera controls. Force-engine positions and mutated edge endpoints stay inside private wrappers; consumer objects are never mutated.

`ActivityNode<Data>`, `ActivityEdge<Data>`, `NodePresentation`, `Activity`, `ActivityGraphProps` and `ActivityGraphHandle` are exported. `./types` is a renderer-free import. `VISUALIZER_CONTRACT_VERSION` is 1; it versions the presentation contract, not any WebSocket protocol. The data parameter lets each application retain strongly typed inspector data.

All times are epoch milliseconds. `highlighted` lights an item; `completedAt` fades that highlight to gray; `removedAt` fades it out. The application removes expired items from its arrays. `updatedAt` animates a call traveling along an edge. Distinct edge IDs preserve incoming/outgoing and different relationship counts. Edge curvature, labels and accent are caller configuration. Different node types are presets of the same card, not renderer subclasses.

Executing nodes pulse with a breathing border and halo. `active` defaults to `status === 'running'`; set it explicitly to preserve an error state while another operation on the same node is still executing. Completed or unhighlighted nodes never pulse. Reduced motion keeps a static active border and indicator.

Give the host a nonzero height. Supply `apiRef` for `fitView()`, `view` for initial framing, and `layoutKey` to reset remembered positions between isolated workspaces. Controlled selection uses `selectedNodeId` and `onNodeSelect`. `onNodeMove` reports drag positions without mutating application state. Arrow keys select nodes, Escape clears, and F fits the view. Reduced motion follows system settings or an explicit prop. Drawing pauses after settling/fading and while hidden/offscreen.

The renderer is loaded only in a browser, so importing the package during SSR is safe. Fonts use system-ui and no global stylesheet is installed. Consumers can freely wrap the component with their own toolbar, inspector and overlays.

## Development and consumption

```sh
npm install
npm run build
npm test
npm pack
```

Install the resulting tarball into a consumer with `npm install ./vendor/atriarch-activity-visualizer-0.2.0.tgz`. The package includes compiled ESM and TypeScript declarations. Local consumers can use this artifact without sibling-repository source imports; registry publishing is a separate action. Virali's prototype is the first consumer; Saga can provide its own catalog and adapter using the same exported contract.

Tests cover frozen consumer input, stable layout across updates, engine array isolation, anchors, edge-first streams, separate directed relationships, removed nodes, duplicate IDs and lifecycle transitions.

## Guided placement

`placeBranches(nodes, edges, previousPositions)` returns new node positions and a
position map to pass to the next update. It places new cards beside their first
observed parent and preserves the slots of existing cards. Consumer-owned
`layout` hints can specify `parentId`, a vertical `lane` (90 units per lane),
and a `leaf`/`group` for compact ordered siblings. Root anchors form a left column.
The helper does not interpret agent kinds or treat repeated/return edges as
new parents. Missing parents and cycles still produce finite positions.

Use the result with `layoutMode="guided"`. Established cards retain their
positions, including manually arranged cards; links do not exert force. The
normal force layout remains the default. Reset the position map and change
`layoutKey` when switching layout modes. The consumer decides whether to pan
or fit a growing graph. The normal force layout remains available for applications that prefer free movement.

## License

This activity visualizer package is licensed under the [MIT License](./LICENSE).
Copyright (c) 2026 Atriarch Systems. This grant applies to this package's own
code and documentation; other Agent Kit packages have their own terms.

MIT permits use, modification, redistribution, and commercial use, provided
the copyright and license notices are retained in copies or substantial portions.
The software is provided as is, without warranty, subject to the license's terms.
No visible application badge is required.

The graph engine is [React Force Graph](https://github.com/vasturiano/react-force-graph)
by Vasco Asturiano (MIT). This package also uses
[D3 Force](https://github.com/d3/d3-force) by Mike Bostock (ISC).
Dependencies remain under their respective licenses; preserve applicable upstream
notices when distributing them. These acknowledgments do not replace their licenses.
