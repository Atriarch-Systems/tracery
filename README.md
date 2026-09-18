# Tracery

<p align="center">
  <a href="https://github.com/Atriarch-Systems/tracery/actions/workflows/ci.yaml"><img src="https://github.com/Atriarch-Systems/tracery/actions/workflows/ci.yaml/badge.svg?branch=main" alt="CI status"></a>
</p>

<p align="center">
  <img src="docs/images/hero.gif" alt="Tracery drawing a live trace: an orchestrator plans and searches, spawns two subagents (one succeeds, one errors), while a guard check and a human approval run concurrently — all rendered live as the graph grows" width="900">
</p>

<p align="center">
  <em>An orchestrator plans, searches, and spawns two subagents — one succeeds, one hits an error — while a guard
  check and a human approval run alongside them. Captured live from the real hosted UI; no editing.
  More in <a href="docs/DEMOS.md">docs/DEMOS.md</a>.</em>
</p>

Tracery by Atriarch Systems turns agent activity events into live, inspectable graphs.
An application pushes small events ("op X started on node Y in flow Z"); the
library or the hub turns them into flows, node histories, and a drawable
graph you can render live or replay after the fact. When one flow spawns
another — an agent starting a subagent — the child links back to its parent
and the whole tree renders as one trace. See [`docs/SPEC.md`](docs/SPEC.md)
for the full specification.

## Usage modes

1. **Library** — embed `@atriarch/tracery-core` + `@atriarch/tracery-react`
   directly in your own app and render the graph from your own event stream.
   No server to run.
2. **Hub** — run `@atriarch/tracery-hub` as a container. Apps push events
   with a client SDK (TypeScript or Python); the hub stores, sorts, serves
   and draws. Nothing renders in the producing app.
3. **Both** — embed the React explorer in your app, but point it at a
   running hub instead of an in-process journal.

Plus a **Claude Code plugin** that streams a running Claude Code session
(tool calls, subagents) to a hub as its own live flow graph.

### Quick start: library

```
npm install @atriarch/tracery-core @atriarch/tracery-react
```

```tsx
import { useMemo } from 'react';
import { Journal } from '@atriarch/tracery-core';
import { ActivityExplorer, useJournalSource } from '@atriarch/tracery-react';

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

The fastest way to a running hub -- no Docker, no keys:

```
npx @atriarch/tracery-hub
```

That binds `127.0.0.1:8971`, runs entirely in memory, and serves the hosted
UI at `http://127.0.0.1:8971/ui/` with auth off ("local mode" -- SPEC.md §6
"Auth mode"): a single `default` workspace, no API key to generate or paste
anywhere. Fine for a laptop, a demo, or trying the plugin; for anything a
second person or process should reach, run it as a container instead with
real keys:

```
docker run -d --name tracery-hub -p 8971:8971 \
  -e TRACERY_API_KEYS='[{"id":"me","key":"CHANGE_ME","workspace":"default","roles":["ingest","read","admin"]}]' \
  atriarch/tracery-hub
```

(a bare `docker run` with no env at all still starts -- the image's own
default is `TRACERY_AUTH=none`, i.e. also local mode, since it binds
`0.0.0.0` rather than loopback; see `apps/hub/README.md`.) Running on a
cluster: `apps/hub/k8s/` (plain manifests) or the
[Helm chart](apps/hub/helm/README.md) -- both expect real
`TRACERY_API_KEYS`/`_FILE` to be configured, same as any other shared
deployment.

```
npm install @atriarch/tracery-client
```

```ts
import { ActivityTracer, httpTransport } from '@atriarch/tracery-client';

const tracer = new ActivityTracer({
  // apiKey is optional against a local-mode hub (see above); against a hub
  // configured with TRACERY_API_KEYS, pass one with the `ingest` role.
  transport: httpTransport({ baseUrl: 'http://127.0.0.1:8971', apiKey: process.env.TRACERY_API_KEY }),
  actor: { id: 'agent:saga', kind: 'agent' },
});
const flow = tracer.startFlow({ label: 'Triage CVE-2026-1234' });
flow.start({ node: 'llm:main', name: 'llm.provider', kind: 'llm' }).end();
flow.end();
await tracer.close();
```

Or from Python: `pip install atriarch-tracery` (see
[`clients/python/README.md`](clients/python/README.md)).

### Quick start: both

```
npm install @atriarch/tracery-react
```

```tsx
import { ActivityExplorer, useHubSource } from '@atriarch/tracery-react';

function MyPage() {
  // apiKey is optional against a local-mode hub (npx @atriarch/tracery-hub, see above).
  const source = useHubSource({ baseUrl: 'http://127.0.0.1:8971', workspace: 'default' });
  return <div style={{ height: '100vh' }}><ActivityExplorer source={source} /></div>;
}
```

### Quick start: Claude Code plugin

One command starts a hub, one starts a session pointed at it -- no key to
generate or paste:

```
npx @atriarch/tracery-hub
```

```
TRACERY_HUB_URL=http://127.0.0.1:8971 claude --plugin-dir ./plugins/claude-code
```

or, from this repo as a marketplace (see
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)):

```
/plugin marketplace add atriarch-systems/tracery
/plugin install tracery@tracery
```

(`atriarch-systems/tracery` is this repo's intended future GitHub location;
point `/plugin marketplace add` at wherever it actually lives, local path
included, until then.) `TRACERY_HUB_URL` (env var or the plugin's own
`hub_url` config prompt) is the only thing required; `TRACERY_API_KEY`/
`api_key` is only needed against a hub configured with `TRACERY_API_KEYS`.
With no `TRACERY_HUB_URL` at all, every hook is a silent no-op. See
[`plugins/claude-code/README.md`](plugins/claude-code/README.md) and
[`docs/CLAUDE-CODE-PLUGIN.md`](docs/CLAUDE-CODE-PLUGIN.md).

## Sharing

Sharing is the viral loop. From a flow or trace's deep link in the hosted
UI, **Share** creates a link (`/s/<token>`) that needs no API key — frozen
at the moment you shared it (`snapshot`, the default) or live-updating
(`live`), with producer context hidden by default and revocable at any
time. No hub reachable from outside your machine? **Export .html** gives
you a single, fully self-contained file that renders the same explorer
offline, straight from disk. Either way, **Download image** turns the
current view into a PNG with a small "Tracery" mark, ready to paste
anywhere. See [`docs/SHARING.md`](docs/SHARING.md) for the full picture —
redaction rules, expiry/revocation, rate limits, Open Graph previews, and
`TRACERY_PUBLIC_URL`.

## Packages

| Package | Path | Version | License |
| --- | --- | --- | --- |
| `@atriarch/tracery-core` | `packages/core` | 0.1.0 | Apache-2.0 |
| `@atriarch/tracery-visualizer` | `packages/visualizer` | 0.3.0 | Apache-2.0 |
| `@atriarch/tracery-client` | `packages/client` | 0.1.0 | Apache-2.0 |
| `@atriarch/tracery-react` | `packages/react` | 0.1.0 | Apache-2.0 |
| `atriarch-tracery` (Python, `atriarch.tracery`) | `clients/python` | 0.1.0 | Apache-2.0 |
| `@atriarch/tracery-hub` | `apps/hub` | 0.1.0 | Apache-2.0 |
| `@atriarch/tracery-hub-web` (hosted UI, not published) | `apps/hub/web` | 0.1.0 | Apache-2.0 |
| `tracery` (Claude Code plugin) | `plugins/claude-code` | 0.1.0 | Apache-2.0 |

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

- [`docs/SPEC.md`](docs/SPEC.md) — the full specification: contract, reducers, visualizer, client SDKs, hub HTTP API, the extensions seam, testing/acceptance.
- [`docs/CLOUD.md`](docs/CLOUD.md) — what Tracery Cloud (the managed service) offers, and how the open hub's extensions seam is what it plugs into.
- [`docs/CLAUDE-CODE-PLUGIN.md`](docs/CLAUDE-CODE-PLUGIN.md) — the Claude Code plugin's hook mapping, privacy details, troubleshooting.
- [`docs/SHARING.md`](docs/SHARING.md) — share links, redaction, expiry/revocation, rate limits, OG previews, image export, standalone HTML export.
- [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) — a longer walkthrough: hub via Docker Compose, a keys file, TS and Python emitters, embedding the explorer, the plugin.
- [`docs/DEMOS.md`](docs/DEMOS.md) — the three demos (Claude Code plugin, npm library, standalone hub): commands, screenshots, and what each distribution can and can't do.
- [`docs/HARDENING.md`](docs/HARDENING.md) — findings from a review/verify/fix pass (confirmed vs. refuted, with reasoning) and the roadmap items delivered alongside it.
- [`docs/VALIDATION.md`](docs/VALIDATION.md) — a from-scratch checklist (exact commands, expected output, PASS/FAIL) for an agent verifying a fresh checkout on a new machine: the npm library, the self-hosted hub (plus Docker), and the Claude Code plugin.
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — the runbook for publishing to npmjs.com, PyPI, Docker Hub/GHCR, and GitHub, plus what `npm run publish:check` proves before every release.
- [`CLAUDE.md`](CLAUDE.md) — repository layout and conventions for agents working in this codebase.

## Licensing

**100% Apache License 2.0.** Every package in this repository — ingest,
storage, retention, the live feed, the hosted UI, the client SDKs, and the
Claude Code plugin — works unlicensed and unmodified; there is no commercial
layer, license key, or feature flag anywhere in this repository. See
[`NOTICE`](NOTICE) for third-party attributions.

## Tracery Cloud

Tracery Cloud is Atriarch Systems' managed hub — accounts, seats, SSO (OIDC),
an audit log, RBAC scopes, managed retention/backups, and support — with a
14-day free trial. It plugs into the open hub through the same
`HubExtensions` seam any self-hosted extensions module could use
([`docs/SPEC.md` §7](docs/SPEC.md#7-extensions-and-tracery-cloud)); its
implementation lives in a private repository, not here. Self-hosted
enterprise is available on request. See [`docs/CLOUD.md`](docs/CLOUD.md).

## Status

CI (`.github/workflows/ci.yaml`) runs the full suite on every push to `main`,
on the project's own self-hosted runners — that live result is the source of
truth, not a point-in-time note in this file. As of this writing all three
jobs are green: `node` (build + every workspace's tests, including Playwright
against a real hub, plus the Claude Code plugin's tests), `python` (3.11),
and `docker` (the hub image builds from a clean checkout). Current test
counts: 36 visualizer + 131 core + 45 client + 50 react + 172 hub + 21
Playwright + 45 plugin + 28 Python, 0 failures.

The first real push to GitHub caught three defects that nothing running on a
developer machine with a pre-built working tree ever could, because a clean
checkout has none of that leftover state: `plugin.json`'s `author` field must
be an object, not a bare string, or Claude Code silently refuses to load the
plugin — only surfaced by installing through the actual
`/plugin marketplace add` + `/plugin install` flow; the Playwright job needed
`npx playwright install --with-deps chromium` on the runner, and the plugin's
own test suite wasn't wired into CI at all; and the Docker build only
explicitly compiled three of the five packages it depends on, silently
relying on leftover `dist/` output from prior local builds to satisfy a
type-only import — invisible on a dirty working tree, and it broke outright
on a truly clean clone with a properly scoped `.dockerignore`. All three are
fixed, verified against fresh clones, and covered by the CI run itself going
forward. See `docs/VALIDATION.md` for the full cold-start checklist (three
usage tracks, exact commands, a report-back template) if you want to
reproduce any of this on another machine.

## Support

☕ Tracery is free and open source. If it saves you time, [buy me a coffee](https://ko-fi.com/demonslyr).

[![ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/demonslyr)

Licensed under the [Apache License, Version 2.0](LICENSE).
