# @atriarch/tracery-hub

Standalone server for Tracery (see [`../../docs/SPEC.md`](../../docs/SPEC.md)
§6). Apps push events with a client SDK (`@atriarch/tracery-client` or the
Python `atriarch-tracery`); the hub stores, sorts, serves and draws. Nothing
renders in the producing app.

```
npx @atriarch/tracery-hub
```

starts the server with an in-memory store and a printed dev API key -- every
setting below has a default, so this works out of the box.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRACERY_PORT` | `8971` | HTTP/WS listen port. |
| `TRACERY_HOST` | `0.0.0.0` | HTTP/WS listen host. |
| `TRACERY_STORE` | `memory` | `memory`, `sqlite`, or `postgres`. |
| `TRACERY_SQLITE_PATH` | `/data/tracery.db` | Database file path, used only when `TRACERY_STORE=sqlite`. |
| `TRACERY_POSTGRES_URL` | unset | `postgres://user:pass@host:5432/db` connection string. **Required** when `TRACERY_STORE=postgres` (the hub fails at boot without it); ignored otherwise. |
| `TRACERY_API_KEYS` | unset | Inline JSON array of API keys (see below). |
| `TRACERY_API_KEYS_FILE` | unset | Path to a JSON file with the same shape as `TRACERY_API_KEYS`. Ignored when `TRACERY_API_KEYS` is set. |
| `TRACERY_RETENTION_HOURS` | `72` | Retention window; the sweeper deletes complete flows older than this. |
| `TRACERY_MAX_EVENTS_PER_WORKSPACE` | `500000` | Soft per-workspace cap enforced by the sweeper (not a hard per-append limit). |
| `TRACERY_METRICS_TOKEN` | unset | When set, `GET /metrics` requires it (`?token=`, `x-metrics-token`, or `Authorization: Bearer`). Unset means `/metrics` is public. |
| `TRACERY_LOG_LEVEL` | `info` | Pino log level (`fatal`..`trace`, or `silent`). |
| `TRACERY_UI_DIR` | `<package>/web/dist` | Directory to serve at `/ui`. When it (or its `index.html`) is missing, `/ui` serves a plain "not built" page instead. |

With neither `TRACERY_API_KEYS` nor `TRACERY_API_KEYS_FILE` set, the hub
generates one dev key at boot with all roles on workspace `default`, logs it
once (`tracery-hub: ... Generated a dev key ...`), and never persists it.
Use this for local development only.

### API key file format

```json
[
  { "id": "saga", "key": "s3cr3t-ingest-key", "workspace": "saga", "roles": ["ingest", "read"] },
  { "id": "explorer", "key": "s3cr3t-read-key", "workspace": "saga", "roles": ["read"] },
  { "id": "operator", "key": "s3cr3t-operator-key", "workspace": "*", "roles": ["ingest", "read", "admin"] }
]
```

- `id` is a label used in logs; it is optional (defaults to `key-<index>`).
- `workspace` is the workspace the key is bound to. Requests never see
  another workspace's data. `workspace: "*"` is the **operator** key: every
  request made with it must name a workspace explicitly (`?workspace=` on
  reads, `{"workspace": "..."}` in the ingest body) except `GET /v1/workspaces`,
  where the operator may omit it to see every workspace's stats.
- `roles` is a non-empty array drawn from `ingest`, `read`, `admin`.
- Present the key as `Authorization: Bearer <key>`, `x-api-key: <key>`, or
  (WebSocket only, since browsers cannot set custom headers on a WS
  handshake) `?token=<key>`.
- Keys are compared in constant time (`crypto.timingSafeEqual` over a
  SHA-256 hash of each candidate), so a wrong key never leaks how much of it
  matched.

### Enterprise SSO (OIDC)

With the `apps/hub/ee` enterprise layer built in and a license carrying the
`sso` feature (see [`../../docs/ENTERPRISE.md`](../../docs/ENTERPRISE.md)),
the hosted UI can authenticate a browser session via an OIDC identity
provider instead of an API key: `TRACERY_OIDC_*` + `TRACERY_SESSION_SECRET`
configure it, `GET /v1/auth/oidc/login` starts the redirect, and a signed,
httpOnly session cookie the browser then holds is accepted anywhere a `read`
role API key would be -- including `GET /v1/flows` and `WS /v1/live` above,
with no `Authorization` header or `?token=` at all. See
`docs/ENTERPRISE.md`'s "SSO (OIDC) for the hosted UI" section for the full
flow, every route, and every environment variable.

## HTTP API

All JSON, all under `/v1` except health/metrics/UI. Full machine-readable
spec at `GET /v1/openapi.json` (OpenAPI 3.1). Errors are always
`{ "error": { "code": "...", "message": "..." } }`; every response carries
`x-request-id`.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/events` | `ingest` | Batch ingest. Body is an `ActivityBatch` (`{ v, workspace?, events }`). Returns `ActivityBatchResult`; `200` when every event was accepted, `207` when some were rejected (see `rejected[]`), `400` for a malformed envelope or a batch over 1000 events. |
| `GET` | `/v1/flows` | `read` | List flows, newest-activity first. Query: `limit` (default 50, max 1000), `before` (opaque cursor from a previous page's `nextBefore`), `status`, `actor`, `trace`, `q` (label substring). |
| `GET` | `/v1/flows/:id` | `read` | Flow summary (`ops`/`nodes`/`edges`, no events). `404` when unknown. |
| `GET` | `/v1/flows/:id/events` | `read` | `ActivityFrame`: a full snapshot, or (with `?after=<cursor>`) just the events after it -- or a `truncated: true` snapshot when `after` is older than what the store still holds. |
| `GET` | `/v1/traces/:id` | `read` | Every flow sharing the resolved trace id, plus spawn links and any `missing` (referenced-but-never-observed) parents. `404` when no flow resolves to this trace. |
| `GET` | `/v1/traces/:id/events` | `read` | Every event for every flow in the trace, cursor-ordered. |
| `GET` | `/v1/workspaces` | `admin` | Workspace stats. A non-operator admin key only ever sees its own workspace. |
| `DELETE` | `/v1/flows/:id` | `admin` | Deletes a flow and its events. `404` when unknown. |
| `GET` | `/healthz` | none | Liveness. |
| `GET` | `/readyz` | none | Readiness (the store answered `stats()`). |
| `GET` | `/metrics` | none, or `TRACERY_METRICS_TOKEN` | Prometheus text exposition. |
| `WS` | `/v1/live?workspace=&flow=&trace=&after=&token=` | `read` | Live feed: a `snapshot` frame, then `events` frames as they're ingested, then a `heartbeat` frame every 15s. Reconnect with `after=<cursor>`; a stale cursor gets a fresh `truncated: true` snapshot instead of a gap. A client that can't keep up (2s send deadline) is disconnected. |
| `GET` | `/`, `/ui/*` | none (the UI does its own key entry) | Hosted explorer, when `apps/hub/web` was built into `TRACERY_UI_DIR`; otherwise a plain placeholder page. |

`workspace` is resolved from the API key, except for the `*` operator key,
which must be given one explicitly (`?workspace=` on every read/WS route,
`{"workspace": "..."}` in the ingest body).

### Metrics

`GET /metrics` exposes: `tracery_events_ingested_total`,
`tracery_events_rejected_total`, `tracery_events_duplicate_total`,
`tracery_flows_total`, `tracery_store_events`, `tracery_ws_clients`,
`tracery_sweeps_total`, `tracery_swept_flows_total`.

## Storage

Three `EventStore` implementations, selected by `TRACERY_STORE`:

- **`memory`** (default): everything in process memory. Simplest option;
  lost on restart.
- **`sqlite`**: `node:sqlite` (`DatabaseSync`, WAL mode), file at
  `TRACERY_SQLITE_PATH`. Events are the durable source of truth on disk;
  flow/trace reduction is kept as an in-memory index, updated incrementally
  on every write (core's single-flow `buildFlow`, exactly like `MemoryStore` --
  see below), so reads never touch disk. This keeps `SqliteStore` behaviourally
  identical to `MemoryStore` (both run the exact same `@atriarch/tracery-core`
  reduction) while adding durability across restarts. It bounds memory use to
  what `TRACERY_MAX_EVENTS_PER_WORKSPACE` allows.
- **`postgres`**: the `pg` package against `TRACERY_POSTGRES_URL`. Same
  design as `SqliteStore` (events on disk, an incrementally-updated in-memory
  flow index, the same materialised `flows` table -- see below), except
  every write (`append`, `deleteFlow`, `sweep`) runs inside one SQL
  transaction and every query is parameterised. **This is the only store
  that supports more than one hub replica** -- `MemoryStore` and
  `SqliteStore` are both single-writer (in-process memory, or a single
  WAL-mode file); pointing several hub instances at the same Postgres
  database is the supported way to scale the hub horizontally or run it
  highly available. `k8s/deployment.yaml` has a commented-out env block for
  switching to it, and `docker-compose.yaml`'s `postgres` profile brings up
  a throwaway Postgres alongside the hub for local testing.

All three stores resolve a flow's `trace` id via core's `resolveTraceIds`/
`assembleTrace` on every append (an O(flows) walk over already-reduced
`{id, link}` pairs, not a re-run of `buildFlows` over the whole event log), so
a parent flow arriving after its child corrects the child's (and any further
descendants') `trace` automatically.

### The `flows` table (SqliteStore, PostgresStore)

`SqliteStore` and `PostgresStore` each keep a `flows` table alongside
`events` -- one row per flow, kept current incrementally the same way the
in-memory index is (on `append`, `deleteFlow` and `sweep`, only the flow(s)
actually touched plus whichever other flows a late-parent trace correction
changed are re-written). It exists for two reasons:

1. **Boot cost.** On open, the store loads the `flows` table straight into
   its in-memory index -- one row read + a `JSON.parse` (`SqliteStore`) or
   an already-parsed `jsonb` value (`PostgresStore`) per flow, O(flows) --
   instead of re-deriving every flow from its entire event history via
   `buildFlows(allEvents)`, which is O(events) and was `SqliteStore`'s old
   startup path. The `events` table is still read into memory at boot (other
   reads need the raw events), but that read no longer feeds a flow-graph
   reduction.
2. **`listFlows`/`flowSummary` are genuinely SQL-backed**: filtering
   (`status`, `actor`, `trace`, `q`), ordering (newest activity first) and
   `before`-cursor paging are all indexed `WHERE`/`ORDER BY` clauses against
   this table, not an in-memory array scan.

`PostgresStore` keeps all of its tables inside one Postgres *schema*
(`public` by default) and creates them on boot if they don't exist yet, with
a `schema_version` row recording the materialised row shape -- a missing
`flows` table or a version mismatch triggers the same one-time O(events)
rebuild described above for `SqliteStore`.

Columns (both stores use the same shape; `SqliteStore`'s TEXT/INTEGER map to
`PostgresStore`'s TEXT/BIGINT/JSONB):

| Column | Meaning |
| --- | --- |
| `workspace`, `id` | Primary key. |
| `trace` | The flow's resolved trace id (SPEC.md §1 "Trace resolution"). |
| `label` | `Flow.label`; matched case-insensitively by `listFlows`' `q` filter. |
| `actor_id`, `actor_kind` | `Flow.actor.id`/`.kind`, `NULL` if the flow has no actor. |
| `status`, `partial` | `Flow.status`; `partial` as `0`/`1`. |
| `started_at`, `ended_at` | `Flow.startedAt`/`.endedAt`, `NULL` when open/unset. |
| `first_cursor`, `last_cursor` | The lowest/highest hub cursor among the flow's retained events; `last_cursor` is `listFlows`' sort/page key (matches "most recent activity first"). |
| `tags_json` | Sorted, deduped JSON array of every op's tags in the flow. |
| `root_node` | The node id of the op whose `start` declared `root: true`, or `NULL` for a partial flow with no root start yet. |
| `data_json` | The full `FlowSummary` (ops/nodes/edges included) as JSON -- what `listFlows`/`flowSummary` actually return. |

A schema-metadata table carries a `flows_schema_version` row -- `schema_meta`
in `SqliteStore`, `schema_version` in `PostgresStore` (the same idea, named
per the task that introduced each store). On open, the store rebuilds the
`flows` table from `events` (the old O(events) `buildFlows` path, run once)
whenever the table is missing (a database/schema from before it existed) or
that row doesn't match the store's current schema version (a future
column/format change) -- then writes the current version so the next boot
takes the fast path again.

### Retention

Every 60s, the sweeper deletes the oldest complete flows first -- oldest by
`startedAt` -- until the workspace is both under `TRACERY_RETENTION_HOURS`
and under `TRACERY_MAX_EVENTS_PER_WORKSPACE`. A `running` flow younger than
the retention window is never swept; a `running` flow *older* than the
window is treated as stale and is swept like any other (this is a safety
valve against a producer that never sends `end`, not a guarantee that
long-running flows survive indefinitely -- keep `TRACERY_RETENTION_HOURS`
generous for genuinely long-running work).

## Docker

Build from the **repository root** (the image needs `packages/core` and,
optionally, `apps/hub/web`):

```
docker build -f apps/hub/Dockerfile -t atriarch/tracery-hub:dev .
docker run --rm -p 8971:8971 atriarch/tracery-hub:dev
```

or with compose (also root-context; see `docker-compose.yaml`):

```
docker compose -f apps/hub/docker-compose.yaml up --build
```

The image is `node:22-alpine`, runs as a non-root user, keeps only
production dependencies, exposes `8971`, declares `VOLUME /data`, and has a
`HEALTHCHECK` against `/healthz` (via Node's built-in `fetch`, no `curl`
dependency in the image). If `apps/hub/web` does not exist yet in the build
context, the image still builds and serves the plain placeholder page at
`/ui` (see `apps/hub/src/routes/ui.ts`).

`TRACERY_API_KEYS_FILE` mounts well as a Docker secret or a read-only bind
mount; see `docker-compose.yaml` and `keys.example.json` for the shape.

`docker-compose.yaml`'s default `hub` service uses `sqlite`. Its `postgres`
profile brings up a throwaway Postgres plus a second hub instance
(`hub-postgres`, host port `8972`) configured with `TRACERY_STORE=postgres`:

```
docker compose -f apps/hub/docker-compose.yaml --profile postgres up --build postgres hub-postgres
```

## Kubernetes

Plain manifests in `k8s/` (Kustomize-friendly, no Helm); a Helm chart
covering the same deployment (plus Ingress, ServiceMonitor and templated
secrets) is at [`helm/`](helm/README.md).

```
kubectl create namespace tracery
kubectl apply -f k8s/secret.example.yaml   # replace with real keys first, or provision via OpenBao/ExternalSecret
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

`deployment.yaml` runs `TRACERY_STORE=sqlite` against the `pvc.yaml` volume,
reads `k8s/secret.example.yaml`'s `keys.json` via `TRACERY_API_KEYS_FILE`,
and sets `replicas: 1` with `strategy: Recreate` -- `memory`/`sqlite` are both
single-writer, so do not scale this beyond one replica unless you switch to
`TRACERY_STORE=postgres` first (see the "Storage" section above). A commented
env block in `deployment.yaml` shows that swap: point `TRACERY_POSTGRES_URL`
at an existing Postgres (via a Secret; OpenBao/ExternalSecret is the
preferred way to provision it) and drop the `data` PVC/volume/mount, then
raise `replicas` and switch `strategy` back to `RollingUpdate`.

## Extending (enterprise layer)

`createServer(config, extensions?)` (`src/server.ts`) is the only seam
`apps/hub/ee` (SPEC.md §7) needs:

```ts
export interface HubExtensions {
  onRequestAuthed?(ctx: { request: FastifyRequest; auth: AuthContext }): void | Promise<void>;
  registerRoutes?(app: FastifyInstance, ctx: HubContext): void | Promise<void>;
  onLiveFrame?(ctx: { auth: AuthContext; frame: ActivityFrame }): ActivityFrame | null;
}
```

- `onRequestAuthed` runs after every successful authentication (before the
  route handler), for audit logging.
- `registerRoutes` runs once at boot with the live Fastify instance and the
  same `HubContext` every built-in route uses (`config`, `store`, `metrics`,
  `keys`, `requireAuth`), for adding routes like `/v1/license` or RBAC
  filtering hooks. It runs after every built-in route is registered and
  before the UI's catch-all 404 handler, so ee's routes are never shadowed.
- `onLiveFrame` runs from `live.ts`'s `send()` before every frame goes out
  over `WS /v1/live` -- the one send path `registerRoutes`'s Fastify `onSend`
  hook can't reach, since the live feed writes to the raw WebSocket outside
  Fastify's response pipeline. Return the frame (unchanged, or with a
  filtered `events` array) to send it, or `null` to drop it entirely.

None of these hooks are invoked by anything in this package; ee (or a test)
passes them into `createServer` directly.

## Development

```
npm run build   # tsc -p tsconfig.json
npm test        # node --test tests/*.test.mjs (builds first)
npm start        # node bin/hub.mjs, reading the environment
```
