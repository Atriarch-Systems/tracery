# Atriarch Activity

Atriarch Activity turns agent activity events into live, inspectable graphs.
An application pushes small events ("op X started on node Y in flow Z"); the
library or the hub turns them into flows, node histories, and a drawable
graph you can render live or replay after the fact. When one flow spawns
another — an agent starting a subagent — the child links back to its parent
and the whole tree renders as one trace. See [`docs/SPEC.md`](docs/SPEC.md)
for the full specification.

## Usage modes

1. **Library** — embed `@atriarch/activity-core` + `@atriarch/activity-react`
   directly in your own app and render the graph from your own event stream.
   No server to run.
2. **Hub** — run `@atriarch/activity-hub` as a container. Apps push events
   with a client SDK (TypeScript or Python); the hub stores, sorts, serves
   and draws. Nothing renders in the producing app.
3. **Both** — embed the React explorer in your app, but point it at a
   running hub instead of an in-process journal.

Plus a **Claude Code plugin** that streams a running Claude Code session
(tool calls, subagents) to a hub as its own live flow graph.

### Quick start: library

```
npm install @atriarch/activity-core @atriarch/activity-react
```

```tsx
import { useMemo } from 'react';
import { Journal } from '@atriarch/activity-core';
import { ActivityExplorer, useJournalSource } from '@atriarch/activity-react';

function MyPage() {
  const journal = useMemo(() => new Journal({ maxEvents: 20_000 }), []);
  // journal.append(events) as your app produces them
  const source = useJournalSource(journal);
  return (
    <div style={{ height: '100vh' }}>
      <ActivityExplorer source={source} />
    </div>
  );
}
```

### Quick start: hub

```
docker run -d --name activity-hub -p 8971:8971 atriarch/activity-hub
docker logs activity-hub   # prints a dev API key on first boot
```

```
npm install @atriarch/activity-client
```

```ts
import { ActivityTracer, httpTransport } from '@atriarch/activity-client';

const tracer = new ActivityTracer({
  transport: httpTransport({ baseUrl: 'http://127.0.0.1:8971', apiKey: process.env.ACTIVITY_API_KEY! }),
  actor: { id: 'agent:saga', kind: 'agent' },
});
const flow = tracer.startFlow({ label: 'Triage CVE-2026-1234' });
flow.start({ node: 'llm:main', name: 'llm.provider', kind: 'llm' }).end();
flow.end();
await tracer.close();
```

Or from Python: `pip install atriarch-activity` (see
[`clients/python/README.md`](clients/python/README.md)).

### Quick start: both

```
npm install @atriarch/activity-react
```

```tsx
import { ActivityExplorer, useHubSource } from '@atriarch/activity-react';

function MyPage() {
  const source = useHubSource({ baseUrl: 'http://127.0.0.1:8971', apiKey: '...', workspace: 'default' });
  return <div style={{ height: '100vh' }}><ActivityExplorer source={source} /></div>;
}
```

### Quick start: Claude Code plugin

```
claude --plugin-dir ./plugins/claude-code
```

or, from a marketplace: `/plugin install atriarch-activity@<marketplace>`. Set
`ACTIVITY_HUB_URL` and `ACTIVITY_API_KEY` (env vars or the plugin's own
config prompts); with neither set, every hook is a silent no-op. See
[`plugins/claude-code/README.md`](plugins/claude-code/README.md).

## Packages

| Package | Path | Version | License |
| --- | --- | --- | --- |
| `@atriarch/activity-core` | `packages/core` | 0.1.0 | MIT |
| `@atriarch/activity-visualizer` | `packages/visualizer` | 0.3.0 | MIT |
| `@atriarch/activity-client` | `packages/client` | 0.1.0 | MIT |
| `@atriarch/activity-react` | `packages/react` | 0.1.0 | MIT |
| `atriarch-activity` (Python, `atriarch.activity`) | `clients/python` | 0.1.0 | MIT |
| `@atriarch/activity-hub` | `apps/hub` | 0.1.0 | MIT (`apps/hub/ee` excluded, see below) |
| `@atriarch/activity-hub-web` (hosted UI, not published) | `apps/hub/web` | 0.1.0 | MIT |
| `atriarch-activity` (Claude Code plugin) | `plugins/claude-code` | 0.1.0 | MIT |

## Event model

An `ActivityEvent` (`packages/core/src/contract.ts`, the wire contract) has
one of four `type`s — `start` / `update` / `end` / `annotate` — for one `op`
(a call instance) on one `node` (a reusable component identity: `llm:main`,
`tool:search`) inside one `flow` (a run of work producing one graph). A child
flow attaches to its parent via `link` on its root `start` event, and every
flow reachable that way resolves to one `trace`.

```json
{
  "v": 1, "id": "01H...", "ts": 1735689600000,
  "flow": "flow:parent", "op": "op:search", "node": "tool:search",
  "type": "end", "name": "tool.search", "status": "success",
  "durationMs": 550, "context": { "hits": 7 }
}
```

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — the full specification: contract, reducers, visualizer, client SDKs, hub HTTP API, enterprise layer, testing/acceptance.
- [`docs/ENTERPRISE.md`](docs/ENTERPRISE.md) — what the commercial layer (`apps/hub/ee`) does, licensing operationally, and the open-core boundary.
- [`docs/CLAUDE-CODE-PLUGIN.md`](docs/CLAUDE-CODE-PLUGIN.md) — the Claude Code plugin's hook mapping, privacy details, troubleshooting.
- [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) — a longer walkthrough: hub via Docker Compose, a keys file, TS and Python emitters, embedding the explorer, the plugin.
- [`CLAUDE.md`](CLAUDE.md) — repository layout and conventions for agents working in this codebase.

## Licensing

Open core. Everything in this repository is **MIT** except
[`apps/hub/ee`](apps/hub/ee), which is source-available under the
[Atriarch Commercial License](apps/hub/ee/LICENSE) (currently a
**placeholder** pending Dan's counsel-approved text). The hub is fully
functional with zero `ee` features: ingest, storage, retention, the live
feed and the hosted UI all work unlicensed and unmodified — the community
edition is the default runtime behavior, with or without `apps/hub/ee`
built into the image. `apps/hub/ee` adds a license-key gate, an audit log,
and RBAC scopes (including for the live feed); see
[`docs/ENTERPRISE.md`](docs/ENTERPRISE.md) for how licensing works and what
each feature requires.

## Status

Workstream G (integration) executed SPEC.md §8 acceptance for real on this
machine (Windows, Node 22.14, Python 3.13, Docker 29) on 2026-09-16. All six
items passed:

1. **`npm ci && npm run build && npm test` (root, all workspaces) and
   `npm run test:plugin`** — PASSED. 119 core + 26 visualizer + 26 client +
   29 react + 51 hub + 39 hub/ee + 8 hub-web Playwright + 20 plugin tests,
   0 failures. `git status --short` after a full build shows no files
   emitted outside each package's own `dist/`.
2. **`python -m pip install -e "clients/python[dev]"` and
   `python -m pytest -q clients/python`** — PASSED. 24 tests, 0 failures
   (Python 3.13; the package also targets 3.11).
3. **`docker build -f apps/hub/Dockerfile .` and `docker run`** — PASSED.
   The image builds from the repo root, ships `apps/hub/ee/dist`, prints a
   dev API key on first boot, and serves `/healthz`, `/v1/openapi.json`,
   `/v1/license` (`{"valid":false,"reason":"no_license"}`, the unmodified
   community edition) and `/ui/`.
4. **`scripts/demo.mjs`** — PASSED. All 9 checks: three flows in one trace,
   both children's resolved trace equals the parent flow id, `project()`
   yields exactly two `spawn` edges and three groups, a WS live subscription
   opened before emission received every event with monotonic cursors, and
   re-sending the first batch reports `duplicates > 0` / `accepted: 0`.
   `npm run demo` runs it against `ACTIVITY_HUB_URL`
   (default `http://127.0.0.1:8971`).
5. **Playwright (`apps/hub/web/tests`) against the running container** —
   PASSED. `explorer.real-hub.spec.ts` now accepts `ACTIVITY_HUB_URL` /
   `ACTIVITY_API_KEY` to target an already-running hub instead of always
   spawning its own; run that way against a freshly-started container, all
   4 tests passed (flow list shows three flows, trace scope shows three
   groups, inspector context, drill-in on double-click).
6. **Visualizer SSR / reduced-motion tests in the root run** — PASSED, as
   part of item 1: `packages/visualizer/tests/model.test.mjs` ("package
   imports and server-renders without a window or document"; "active cards
   pulse; idle, completed, gray and reduced-motion cards stay still") and
   `packages/react/tests/explorer-ssr.test.mjs`.

Four integration defects found during this workstream were fixed as part of
this run: the enterprise build leaking compiled `.js`/`.d.ts` files into
`apps/hub/src` (now uses TypeScript project references, `tsc -b`); the
Docker image not shipping `apps/hub/ee/dist`; `apps/hub/package.json`
`"files"` omitting `ee/`; and the live feed (`WS /v1/live`) not being
RBAC-filterable (`HubExtensions.onLiveFrame`, implemented in
`apps/hub/ee/src/rbac.ts`, tested with a real WebSocket client). Nothing
found during acceptance itself failed and was left unfixed.
