# CLAUDE.md — Tracery

Agent activity graphs: an event contract, pure reducers, a React canvas
visualizer, emitter SDKs (TS + Python) and a standalone hub server that stores
and draws activity pushed by many applications.

Read `docs/SPEC.md` before changing anything. `packages/core/src/contract.ts` is
the wire contract; a change there is a versioned contract change with a golden test.

## Layout

| Path | Package | What |
| --- | --- | --- |
| `packages/core` | `@atriarch/tracery-core` | contract, validation, journal, flows, traces, projection. No DOM, no React. |
| `packages/visualizer` | `@atriarch/tracery-visualizer` | canvas component (moved here from atriarch-agentkit). |
| `packages/react` | `@atriarch/tracery-react` | `ActivityExplorer` composite + live-source hooks. |
| `packages/client` | `@atriarch/tracery-client` | TS emitter SDK + hub read client. |
| `clients/python` | `atriarch-tracery` | Python emitter SDK, stdlib only, `atriarch.tracery`. |
| `apps/hub` | `@atriarch/tracery-hub` | Fastify server, stores, live feed, hosted UI, Docker, k8s. |

Tracery Cloud (accounts, SSO, audit log, RBAC, managed retention/backups) is
a private `tracery-cloud` repository, not part of this checkout. It plugs
into `apps/hub` via the `HubExtensions` seam (`apps/hub/src/server-context.ts`,
loaded through `TRACERY_EXTENSIONS_MODULE`) -- see `docs/SPEC.md` §7 and
`docs/CLOUD.md`.

## Conventions

- ESM only, TypeScript strict, `tsconfig.json` extends `../../tsconfig.base.json`.
- Tests: `node --test tests/*.test.mjs` against `dist/`, build first. Python: pytest.
- Consumer inputs are `readonly` and never mutated. No `any` in exports.
- Node >= 22.13 (`node:sqlite`). Python 3.11 is the supported interpreter.
- CI runs on self-hosted runners only. Never `runs-on: ubuntu-latest`.
- Licensing: 100% Apache-2.0. No commercial code, license gate, or feature flag lives in this repository.

## Commands

```bash
npm ci && npm run build && npm test            # all workspaces
python -m pip install -e clients/python[dev] && python -m pytest -q clients/python
docker build -f apps/hub/Dockerfile -t atriarch/tracery-hub .
node scripts/demo.mjs                           # end-to-end against a running hub
```

## Git hygiene

Stage explicit paths, never `git add -A`. Other agents may be working in
sibling directories of this checkout.
