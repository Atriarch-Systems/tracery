# Tracery Cloud

Tracery by Atriarch Systems is **free and open source, Apache-2.0, full stop.**
Every package in this repository -- the contract, reducers, visualizer, React
explorer, client SDKs, the standalone hub (including its hosted UI, storage
engines, retention, and live feed) and the Claude Code plugin -- is
100% Apache-2.0. There is no paid tier of the software itself, no feature
flag in this repository that unlocks with a key, and no part of self-hosting
the hub that requires a license. See [`SPEC.md` §7](SPEC.md#7-extensions-and-tracery-cloud)
for the extension seam this document builds on, and the root
[`README.md`](../README.md) for the licensing summary.

## Tracery Cloud is the managed service

**Tracery Cloud** is Atriarch Systems' hosted, managed version of the hub,
plus the operational and organizational features that only make sense for a
managed service or a larger self-hosted team:

- **Accounts and seats** -- sign up, invite teammates, manage who has access.
- **SSO (OIDC)** -- sign in with your identity provider instead of an API key.
- **Audit log** -- every authenticated request recorded, exportable.
- **RBAC** -- API keys scoped to specific actors/tags, for ingest and reads.
- **Retention and backups** -- longer/managed retention than a self-run
  `TRACERY_RETENTION_HOURS`, with backups Atriarch Systems operates.
- **Support** -- a real person to ask, instead of a GitHub issue queue.

A **14-day trial** is available with no credit card at
[atriarch.systems](https://atriarch.systems) -- sign up, get a hub URL, point
your client SDK at it. Nothing in this repository is required to try it;
nothing in this repository changes if you never do.

**Self-hosted enterprise** (the same feature set above, running on your own
infrastructure instead of Atriarch Systems') is available on request --
reach out at [atriarch.systems](https://atriarch.systems) or via the
[support link](https://ko-fi.com/demonslyr) in this repository. It ships as a
private extensions module (see below), not as code that lives in this
repository.

## How Cloud plugs into the open hub

The open-source hub (`@atriarch/tracery-hub`, `apps/hub`) has exactly one
integration point for anything beyond what ships in this repository: the
`HubExtensions` interface (`apps/hub/src/server-context.ts`), loaded at
startup via the `TRACERY_EXTENSIONS_MODULE` environment variable
(`apps/hub/README.md` "Extensions"). Tracery Cloud's SSO/audit/RBAC
implementation is exactly such a module -- it is not special-cased by the
hub in any way, and its source lives in a private repository
(`tracery-cloud`), not here.

```ts
export interface HubExtensions {
  onRequestAuthed?(ctx: { request: FastifyRequest; auth: AuthContext }): void | Promise<void>;
  registerRoutes?(app: FastifyInstance, ctx: HubContext): void | Promise<void>;
  onLiveFrame?(ctx: { auth: AuthContext; frame: ActivityFrame }): ActivityFrame | null;
  isLicensed?(): boolean;
}
```

Nothing about this seam is Cloud-specific: `HubExtensions` is itself
Apache-2.0 and generic. Anyone can write a different extensions module
against the same seam (`apps/hub/README.md` "Extensions" documents exactly
what each hook does and when it runs); Tracery Cloud is simply the one
Atriarch Systems builds, hosts, and supports.

A hub started with no `TRACERY_EXTENSIONS_MODULE` set -- the default, and
everything this repository's own tests/CI exercise -- reports
`GET /v1/info` `edition: "community"`, has no `/v1/license` route at all, and
is in every other respect the identical hub that ships when Tracery Cloud
does not exist.
