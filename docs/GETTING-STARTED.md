# Getting started

A longer walkthrough than the root [`README.md`](../README.md)'s quick
starts: running the hub with Docker Compose and a real keys file, emitting
from TypeScript and Python, embedding the React explorer against that hub,
and wiring up the Claude Code plugin. See [`docs/SPEC.md`](SPEC.md) for the
full specification and [`docs/ENTERPRISE.md`](ENTERPRISE.md) for the
commercial layer this guide doesn't need.

## 1. Run the hub

### With Docker Compose (recommended for anything beyond a laptop demo)

`apps/hub/docker-compose.yaml` builds from the repository root (the image
needs `packages/core` and, optionally, the hosted UI in `apps/hub/web`) and
mounts a keys file instead of relying on the auto-generated dev key:

```sh
cd apps/hub
docker compose -f docker-compose.yaml up --build
```

This starts the hub with `TRACERY_STORE=sqlite` (durable across restarts,
volume `tracery-data`) and `TRACERY_API_KEYS_FILE` pointed at
`./keys.example.json`, mounted read-only. **Copy that file and replace the
placeholder keys before using this anywhere but a laptop**:

```sh
cp apps/hub/keys.example.json apps/hub/keys.json
```

```json
[
  { "id": "saga", "key": "s3cr3t-ingest-key", "workspace": "saga", "roles": ["ingest", "read"] },
  { "id": "explorer", "key": "s3cr3t-read-key", "workspace": "saga", "roles": ["read"] },
  { "id": "operator", "key": "s3cr3t-operator-key", "workspace": "*", "roles": ["ingest", "read", "admin"] }
]
```

Then point the compose file's volume mount at `keys.json` instead of
`keys.example.json` (or edit `docker-compose.yaml` directly), and keep
`keys.json` out of version control. Each key is bound to one `workspace`
(requests never see another workspace's data) except the `workspace: "*"`
**operator** key, which must name a workspace explicitly on every request
except `GET /v1/workspaces`. `roles` controls what the key may do: `ingest`
(`POST /v1/events`), `read` (everything under `GET /v1/flows*` and
`/v1/traces*`, plus `WS /v1/live`), `admin` (`DELETE /v1/flows/:id`,
`GET /v1/workspaces`).

### Plain `docker run` (quickest way to try it)

```sh
docker build -f apps/hub/Dockerfile -t atriarch/tracery-hub:dev .   # from the repo root
docker run --rm -p 8971:8971 atriarch/tracery-hub:dev
```

With no `TRACERY_API_KEYS`/`TRACERY_API_KEYS_FILE` set, the hub generates
one dev key at boot with every role on workspace `default`, and logs it
once — read it from the container's stdout. This mode keeps everything in
memory (`TRACERY_STORE=memory`, the default); nothing survives a restart.
Full environment variable reference: [`apps/hub/README.md`](../apps/hub/README.md).
Running on a cluster instead: plain manifests in `apps/hub/k8s/`, or the
Helm chart at [`apps/hub/helm/`](../apps/hub/helm/README.md).

Either way, confirm it's up:

```sh
curl http://127.0.0.1:8971/healthz          # {"status":"ok"}
curl http://127.0.0.1:8971/v1/license        # community edition unless TRACERY_LICENSE_KEY is set
open http://127.0.0.1:8971/ui/               # hosted explorer (asks for an API key on first load)
```

## 2. Emit events

### TypeScript

```sh
npm install @atriarch/tracery-client
```

```ts
import { ActivityTracer, httpTransport } from '@atriarch/tracery-client';

const tracer = new ActivityTracer({
  transport: httpTransport({ baseUrl: 'http://127.0.0.1:8971', apiKey: process.env.TRACERY_API_KEY! }),
  actor: { id: 'agent:saga', kind: 'agent' },
});

const flow = tracer.startFlow({ label: 'Triage CVE-2026-1234' });
const op = flow.start({ node: 'llm:main', name: 'llm.provider', kind: 'llm' });
op.update({ context: { tokens: 120 } });
op.end({ status: 'success', context: { model: 'qwen3.6:35b-a3b' } });

// Hand a subagent the link it needs to attach its own flow to this one.
const link = flow.spawnLink(op);
await spawnSubagent(link); // however you launch the subagent process/task

flow.end();
await tracer.flush();
await tracer.close();
```

The subagent process constructs its own tracer and starts its flow with the
link it was handed (env var, IPC message, CLI argument — whatever fits):

```ts
const subTracer = new ActivityTracer({
  transport: httpTransport({ baseUrl: 'http://127.0.0.1:8971', apiKey: process.env.TRACERY_API_KEY! }),
  actor: { id: 'agent:saga/subagent:research-7', kind: 'subagent' },
});
const subFlow = subTracer.startFlow({ label: 'Research CVE-2026-1234', link });
subFlow.start({ node: 'tool:search', name: 'tool.call', kind: 'tool' }).end();
subFlow.end();
await subTracer.close();
```

The hub resolves the two flows into one trace, with a `spawn` edge from the
parent's `llm:main` op to the subagent's root node. Full API:
[`packages/client/README.md`](../packages/client/README.md).

### Python

```sh
python -m pip install atriarch-tracery
```

```python
import os
from atriarch.tracery import ActivityTracer, HttpTransport

tracer = ActivityTracer(
    transport=HttpTransport(base_url="http://127.0.0.1:8971", api_key=os.environ["TRACERY_API_KEY"]),
    actor={"id": "agent:saga", "kind": "agent"},
)

flow = tracer.start_flow(label="Triage CVE-2026-1234")
with flow.op(node="llm:main", name="llm.provider", kind="llm") as op:
    op.update(context={"tokens": 120})
    # op.end() runs automatically on exit: 'success', or 'error' with the
    # exception's class name if the block raised.

link = flow.spawn_link(op)
spawn_subagent(link)

flow.end()
tracer.close()
```

`with flow.op(...) as op:` also makes the op "current" via `contextvars`, so
a nested `flow.start(...)` inside the block picks it up as an implicit
parent — no explicit `parent=` plumbing needed. Full API:
[`clients/python/README.md`](../clients/python/README.md).

## 3. Embed the explorer

Point `@atriarch/tracery-react`'s `ActivityExplorer` at the hub you started
in step 1 — no server code of your own:

```sh
npm install @atriarch/tracery-react
```

```tsx
import { ActivityExplorer, useHubSource } from '@atriarch/tracery-react';

function ActivityPage() {
  const source = useHubSource({
    baseUrl: 'http://127.0.0.1:8971',
    apiKey: 'a read-role key for your workspace',
    workspace: 'saga', // or the workspace your key is bound to
  });

  return (
    <div style={{ height: '100vh' }}>
      <ActivityExplorer source={source} />
    </div>
  );
}
```

`useHubSource` opens `WS /v1/live` and reduces every frame into `Flow`s,
reconnecting with backoff and falling back to polling after two failed
connections. Pass `flow` or `trace` to scope the whole explorer to one flow
or trace instead of the workspace. If you'd rather skip the hub entirely and
feed events straight from your own process, see the **library** mode
quick start in the root README, or
[`packages/react/README.md`](../packages/react/README.md) for the full
`ActivityExplorer` prop reference (scope switching, the inspector, theming).

## 4. The Claude Code plugin

Streams a running Claude Code session — tool calls, subagent spawns — to a
hub as its own live flow graph, so you can watch a session the same way you'd
watch any other producer's activity.

```sh
claude --plugin-dir ./plugins/claude-code
```

(or `/plugin install tracery@<marketplace>` once published to
one). Configure it with environment variables or the prompts Claude Code
shows when the plugin is enabled:

| Env var | Required | Default |
| --- | --- | --- |
| `TRACERY_HUB_URL` | yes | — |
| `TRACERY_API_KEY` | yes (needs the `ingest` role) | — |
| `TRACERY_WORKSPACE` | no | `default` |
| `TRACERY_INCLUDE_PROMPTS` | no | `false` |

With neither `TRACERY_HUB_URL` nor `TRACERY_API_KEY` set, every hook is a
silent no-op — installing the plugin without configuring it does nothing. A
session becomes one flow; each subagent becomes its own child flow linked
back to the `Agent` tool call that spawned it. Full hook-to-event mapping,
the redaction rules (what never leaves the machine), and troubleshooting:
[`docs/CLAUDE-CODE-PLUGIN.md`](CLAUDE-CODE-PLUGIN.md).

## Next steps

- [`docs/SPEC.md`](SPEC.md) — the full contract, reducer semantics, hub HTTP
  API, and the projection rules the visualizer relies on.
- [`docs/ENTERPRISE.md`](ENTERPRISE.md) — licensing, the audit log, and RBAC
  scopes if you need to restrict what a key can see or ingest.
- `node scripts/demo.mjs` — a scripted end-to-end run (a parent flow
  spawning one TypeScript and one Python child) against a hub you already
  have running, useful as a working example of everything on this page at
  once.
