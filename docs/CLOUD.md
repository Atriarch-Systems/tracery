# Tracery Cloud

Tracery's original community code is Apache-2.0. Third-party code retains its
own licenses; see [LICENSING.md](LICENSING.md). The source release has no paid
feature gate and does not require purchasing hosting.

Atriarch's managed hosting and private enterprise extension offering are separate
from this repository. Contact [Atriarch Systems](https://atriarch.systems) for
current availability, supported identity integrations, service features and terms.
The extension interface supports integrations such as OIDC SSO, audit and RBAC.
This tag does not claim a working signup/trial, SAML implementation, billing system,
or managed backups; verify those against the operated service before advertising them.

## How Cloud plugs into the open hub

The open-source hub (`@atriarch-systems/tracery-hub`, `apps/hub`) has exactly one
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
