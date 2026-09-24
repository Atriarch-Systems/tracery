# tracery-hub

Helm chart for [`@atriarch-systems/tracery-hub`](../README.md) (SPEC.md §6), the
standalone Tracery activity-graph server. This is an alternative to the
plain manifests in [`../k8s/`](../k8s/) -- pick one, not both, for a given
release.

```sh
helm install tracery-hub apps/hub/helm \
  --namespace tracery --create-namespace \
  -f my-values.yaml
```

## What this chart deploys

- **Deployment** running `atriarchsystems/tracery-hub`, liveness on `/healthz` and
  readiness on `/readyz`, a non-root `securityContext` on both pod and
  container, resource requests/limits.
- **Service** (ClusterIP by default) on `service.port` (default `8971`).
- **Ingress** (optional, `ingress.enabled`), with TLS.
- **ConfigMap** for every non-secret hub setting (`TRACERY_PORT`,
  `TRACERY_STORE`, `TRACERY_RETENTION_HOURS`, ...).
- **Secret** for `TRACERY_API_KEYS_FILE` (`apiKeys.keys`, rendered inline, or
  `apiKeys.existingSecret` pointing at one you provisioned yourself --
  OpenBao/ExternalSecret is the preferred way for anything real).
- **PVC** for `/data`, only when `config.store` is `sqlite`
  (`persistence.enabled`, or point at one you already made with
  `persistence.existingClaim`).
- **ServiceMonitor** (optional, `serviceMonitor.enabled`) scraping
  `GET /metrics`.

This chart deploys the open-source community hub only. Tracery Cloud's
extensions module (SPEC.md §7 "Extensions and Tracery Cloud") is a separate
concern -- it plugs in at runtime via `TRACERY_EXTENSIONS_MODULE`, which this
chart does not currently template; set it via `config` (a custom
`extraEnv`-style override, or your own values patch) if you deploy it.

## Storage and `replicaCount`

`memory` and `sqlite` (`node:sqlite`, WAL mode, one file) are both
single-writer stores -- apps/hub/README.md "Storage" is explicit that
scaling either beyond one replica corrupts nothing but simply doesn't do
what you want (each replica would keep its own, diverging view). This chart
enforces that at template time: **`helm template`/`helm install` refuses to
render a Deployment with `replicaCount` other than `1` unless
`config.store` is `postgres`**, with a message pointing at the fix. Only
`postgres` supports more than one replica -- point every replica at the same
database via `postgres.url` or (preferred) `postgres.existingSecret`, and
Helm will accept `replicaCount > 1`.

```sh
# fails at template time with a clear message
helm template t apps/hub/helm --set config.store=sqlite --set replicaCount=2

# works: postgres is multi-writer-safe
helm template t apps/hub/helm --set config.store=postgres --set replicaCount=3 \
  --set postgres.existingSecret=tracery-hub-postgres
```

Switching `config.store` from `sqlite` to `postgres` also drops the `/data`
PVC and volume mount, and flips the Deployment's update `strategy` from
`Recreate` to `RollingUpdate`.

## API keys

Leaving `apiKeys.keys` and `apiKeys.existingSecret` both empty deploys the
hub with **no** `TRACERY_API_KEYS_FILE` at all. There is no dev-key fallback
(apps/hub/README.md "Auth mode"): the hub fails at boot with "TRACERY_HOST is
not loopback and no API keys are configured" unless `config.authNone` is also
set to `true` (only for a hub deliberately run behind something that already
authenticates -- a reverse proxy, service mesh, or network policy). Prefer
`apiKeys.existingSecret` provisioned out of band (OpenBao + ExternalSecret)
over the inline `apiKeys.keys` list, which lands real key material in your
values / release history.

```yaml
apiKeys:
  keys:
    - id: saga
      key: CHANGE_ME
      workspace: saga
      roles: ["ingest", "read"]
    - id: operator
      key: CHANGE_ME
      workspace: "*"
      roles: ["ingest", "read", "admin"]
```

or

```yaml
apiKeys:
  existingSecret: tracery-hub-keys   # must contain a `keys.json` key (existingSecretKey)
```

## Values

| Key | Default | Description |
| --- | --- | --- |
| `image.repository` | `atriarchsystems/tracery-hub` | Image repository. |
| `image.tag` | `""` (→ `.Chart.AppVersion`) | Image tag. |
| `image.pullPolicy` | `IfNotPresent` | Image pull policy. |
| `imagePullSecrets` | `[]` | Pull secrets for a private registry. |
| `nameOverride` / `fullnameOverride` | `""` | Override the generated resource-name prefix. |
| `replicaCount` | `1` | Deployment replicas. See "Storage and `replicaCount`" above. |
| `podSecurityContext` | non-root, uid/gid/fsGroup `1000` | Pod-level `securityContext`. |
| `securityContext` | drop `ALL`, no privilege escalation | Container-level `securityContext`. |
| `service.type` / `service.port` | `ClusterIP` / `8971` | Service. |
| `ingress.enabled` | `false` | Create an Ingress. |
| `ingress.className`, `.annotations`, `.host`, `.path`, `.pathType` | -- | Ingress fields. |
| `ingress.tls.enabled` / `.secretName` | `false` / `""` | TLS on the Ingress; empty `secretName` lets an annotation-driven issuer (e.g. cert-manager) create one. |
| `resources` | `100m`/`128Mi` request, `512Mi` limit | Container resources. |
| `livenessProbe` / `readinessProbe` | `/healthz` / `/readyz` | Full probe objects, overridable. |
| `config.port`, `.host` | `8971`, `0.0.0.0` | `TRACERY_PORT` / `TRACERY_HOST`. |
| `config.store` | `sqlite` | `TRACERY_STORE`: `memory`, `sqlite`, or `postgres`. |
| `config.sqlitePath` | `/data/tracery.db` | `TRACERY_SQLITE_PATH` (used only when `store: sqlite`). |
| `config.retentionHours` | `72` | `TRACERY_RETENTION_HOURS`. |
| `config.maxEventsPerWorkspace` | `500000` | `TRACERY_MAX_EVENTS_PER_WORKSPACE`. |
| `config.logLevel` | `info` | `TRACERY_LOG_LEVEL`. |
| `config.uiDir` | `""` | `TRACERY_UI_DIR` override; empty uses the image default. |
| `persistence.enabled` | `true` | Create/mount the `/data` PVC (only takes effect when `config.store: sqlite`). |
| `persistence.size`, `.storageClassName`, `.accessMode` | `10Gi`, `""`, `ReadWriteOnce` | PVC spec. |
| `persistence.existingClaim` | `""` | Use an existing PVC instead of creating one. |
| `apiKeys.keys` | `[]` | Inline API keys (SPEC.md §6 "Auth"), rendered into a Secret. |
| `apiKeys.existingSecret` / `.existingSecretKey` | `""` / `keys.json` | Use a Secret you already made instead. |
| `postgres.url` | `""` | `TRACERY_POSTGRES_URL`, rendered into a Secret. Convenience only -- prefer `existingSecret`. |
| `postgres.existingSecret` / `.existingSecretKey` | `""` / `url` | Use a Secret you already made instead. Required when `config.store: postgres`. |
| `metrics.token` | `""` | `TRACERY_METRICS_TOKEN`, rendered into a Secret. Empty means `/metrics` is public. |
| `metrics.existingSecret` / `.existingSecretKey` | `""` / `token` | Use a Secret you already made instead. |
| `serviceMonitor.enabled` | `false` | Create a Prometheus Operator `ServiceMonitor`. |
| `serviceMonitor.namespace`, `.interval`, `.scrapeTimeout`, `.labels`, `.path` | -- | ServiceMonitor fields. |

## Linting and templating

```sh
helm lint apps/hub/helm
helm template t apps/hub/helm
helm template t apps/hub/helm --set config.store=postgres --set replicaCount=2 \
  --set postgres.existingSecret=tracery-hub-postgres
helm template t apps/hub/helm --set config.store=sqlite --set replicaCount=2   # fails on purpose
```
