# @atriarch/activity-core

Contract, validation, journal, flow reducers, trace assembly and visualizer
projection for Atriarch Activity. Pure TypeScript, no DOM, no React, no I/O.
Runs in Node and browsers. See [`../../docs/SPEC.md`](../../docs/SPEC.md) §1–§2
for the full semantics; this README is a usage guide.

```
npm install @atriarch/activity-core
```

```ts
import { validateEvent, validateBatch } from '@atriarch/activity-core';
import { Journal } from '@atriarch/activity-core';
import { buildFlows, buildFlow } from '@atriarch/activity-core';
import { assembleTrace, ancestors } from '@atriarch/activity-core';
import { project } from '@atriarch/activity-core';
import { sampleTraceEvents, buildSampleFlows } from '@atriarch/activity-core/fixtures';
import type { ActivityEvent } from '@atriarch/activity-core/contract';
```

Subpath exports: `.` (everything), `./contract` (wire types only, no logic),
`./fixtures` (the deterministic sample trace described below).

## Validation

```ts
const result = validateEvent(rawJson);
if (!result.ok) {
  console.warn(result.reason); // e.g. "event.status must be one of running, success, error, cancelled, skipped"
} else {
  journal.append([result.event]);
}
```

`validateEvent`/`validateBatch` never throw. They return a canonical, trimmed
event/batch (unknown fields are dropped) or `{ ok: false, reason }` with a
precise reason string. Limits (`ACTIVITY_LIMITS`) are enforced: 1000 events per
batch, 64 KB per event, 256-char ids, 32 tags.

## Journal

A bounded, deduplicating, ordered event log for the library-only path (no hub):

```ts
const journal = new Journal({ maxEvents: 50_000 });
const { added, duplicates } = journal.append(events);
journal.events();              // ordered by (ts, seq ?? 0, arrival)
journal.eventsForFlow('flow:parent');
journal.partial;               // true once eviction has dropped events
```

## Flows

```ts
const flows = buildFlows(journal.events());   // ReadonlyMap<string, Flow>
const flow = flows.get('flow:parent');
flow.status;   // 'running' | 'error' | 'unknown' | 'complete'
flow.ops;      // ReadonlyMap<string, OpRecord>
flow.nodes;    // ReadonlyMap<string, NodeRecord>
flow.edges;    // readonly EdgeRecord[]
flow.trace;    // resolved trace id (SPEC.md §1 "Trace resolution")

const single = buildFlow(journal.eventsForFlow('flow:parent')); // fast path
```

## Traces

```ts
const trace = assembleTrace(flows, 'flow:research-1'); // works from any member flow
trace.root;     // trace root flow id
trace.flows;    // every flow sharing the resolved trace id
trace.missing;  // parentFlow ids referenced but never observed

ancestors(flows, 'flow:research-1'); // root-first parent chain, excluding the flow itself
```

## Projecting to the visualizer

```tsx
import { ActivityGraph } from '@atriarch/activity-visualizer';

// This flow's own graph: raw node ids.
const { nodes, edges, groups } = project(flows, { mode: 'flow', flow: 'flow:parent' });

// This flow plus its ancestor chain, root-first, ancestors dimmed: namespaced ids.
project(flows, { mode: 'ancestors', flow: 'flow:research-1' });

// The whole trace this flow belongs to, with spawn edges between flows: namespaced ids.
project(flows, { mode: 'trace', trace: flows.get('flow:parent').trace });

<ActivityGraph nodes={nodes} edges={edges} groups={groups.map(g => ({ id: g.id, label: g.label }))} />
```

`project()` never mutates a `Flow`. Rules (SPEC.md §2 "Projection rules"):

- `flow` scope uses raw `node` ids; `ancestors`/`trace` scope namespace them as
  `${actor.id ?? flow.id}::${node}` so two agents' `llm:main` stay apart while
  one agent's repeated flows in a trace merge onto shared nodes.
- Each flow in scope becomes a `FlowGroup`. In `ancestors` scope, the chosen
  flow is `activity.highlighted: true`; ancestor flows are `false` (dimmed).
- A child flow's root node gets a `kind: 'spawn'` edge from `link.parentNode`
  (or the parent's root node when unset) with `layout.parentId` pointing at
  that source, so `placeBranches` in the visualizer grows the subgraph beside
  its spawner. Only drawn when the parent flow is also in scope.
- `dataFrom` produces `kind: 'data'` edges; self edges (`parentNode === node`)
  are suppressed, though the op stays in that node's history (`data.ops`).
- Node `status` is `error` if any of its ops errored, `running` if any is
  open, else `idle`; `active = running > 0`; `detail` is the last op name;
  `footer` is `${ops.length} ops` or `${errorCount} errors`.
- `options.catalog` maps a `NodeRecord` to a `NodePresentation`; the default
  (`defaultCatalog`, exported) covers `agent`, `subagent`, `llm`, `tool`,
  `memory`, `guard`, `human`, `service`, and a generic fallback.
- `options.history.keepCompletedMs` drops nodes that finished more than that
  long before `options.now` (default `Date.now()`); still-running nodes are
  always kept regardless of age.

## Fixtures

`@atriarch/activity-core/fixtures` exports a deterministic ~40-event sample
trace: `agent:orchestrator` plans, searches, checks a guard, gets human
approval, then spawns `subagent:research-1` and `subagent:research-2` from the
same search op. Each subagent plans, searches, writes memory and reports back;
research-1's memory write carries a `dataFrom` back to its own search, and
research-2's search fails (its flow ends up `status: 'error'`). Fixed ids and
timestamps, safe to assert against byte-for-byte; used by this package's own
tests, by other workstreams, and by `scripts/demo.mjs`.

```ts
import { sampleTraceEvents, sampleFlowIds, buildSampleFlows } from '@atriarch/activity-core/fixtures';

const flows = buildSampleFlows();          // ReadonlyMap<string, Flow>, 3 flows
flows.get(sampleFlowIds.research2).status; // 'error'
```

## Development

```
npm run build   # tsc -p tsconfig.json
npm test        # node --test tests/*.test.mjs (runs against dist/, build first)
```
