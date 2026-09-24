# Changelog

## v0.1.1 — release candidate (registries pending)

- Publish tested npm packages and Docker images through tag-triggered GitHub
  Actions, with manual validate/publish controls and retained SBOM/scan evidence.
- Create annotated release tags and draft GitHub releases from the manual workflow.
- Build and test AMD64 and ARM64 containers on native runners; publish combined
  version/latest tags plus explicit architecture tags after both pass.
- Include matching Alpine sources, patches, build recipes and notices with each
  container; preserve Node's complete license and enforce the reviewed inventory.
- Preserve Vite and bundled runtime-helper notices in browser builds and exports.
- Pin new and restored guided-layout nodes before the first physics tick.
- Remove unused npm/Corepack/Yarn from the runtime image and pin upstream images.
- Reject unreviewed final-artifact licenses, secrets and high/critical
  vulnerability findings before publication.
- Release workflow reads the npmjs.com token from NPMJS_TOKEN (was NPM_TOKEN) so
  it cannot be confused with the internal Nexus registry's credentials.
- Prepare core/client/React/hub 0.1.1 and visualizer 0.3.1. Python remains 0.1.0.
- Packages are published under the @atriarch-systems npm scope (the org that
  exists); the visualizer's package name changes with it.

- Make the client flush-concurrency regression deterministic: control timer ticks
  and transport completion instead of assuming eleven sends finish within 500 ms.

- Make source builds the active hub/plugin quick start; mark npm, PyPI and
  prebuilt Docker distribution as pending. Add the missing local image build
  step and correct Docker smoke commands for explicit local authentication opt-out.

## v0.1.0 — source release

This is the first coordinated GitHub source release. npm, PyPI and container
publication are separate; use the checkout/build instructions in README.md.
The visualizer retains its existing package version 0.3.0; this repository tag
does not reset independent package or wire-contract versions.

### Fixes

- Remember manually dragged node/group positions across live updates, follow-latest
  flow changes and temporarily leaving a scope. Reload/remount clears this cache.
- Close active live shares on revocation and expiry; recheck authorization before
  sending snapshots, updates and heartbeats, and handle store errors safely.
- Restrict browser HTTP and WebSocket origins to the hub and an explicit allowlist;
  reject opaque origins and local-mode DNS-rebinding hostnames.
- Remove the container's implicit unauthenticated network default. Local container
  use now requires an explicit opt-out and should publish its port on loopback.
- Ship renderer-free core projection declarations that compile in an isolated
  TypeScript consumer. Import ActivityGraphProps/ActivityGraphHandle from
  @atriarch-systems/tracery-visualizer, rather than the core package.
- Freeze animation-test clocks to eliminate the default-theme CI race.
- Upgrade @fastify/static to 10.1.4; the updated npm dependency audit reports no findings.

### Distribution and contribution

- Generate complete third-party notices for hosted, offline and example UI builds;
  preserve reviewed upstream license fallbacks and copy notices into the Dockerfile.
- Add the locked-dependency license gate, Trivy license inventory and CycloneDX
  source SBOM artifacts to CI. Final container scanning remains a separate check.
- Add CONTRIBUTING.md, SECURITY.md and redistribution guidance. Enable GitHub private
  vulnerability reporting. Skip fork PR execution on shared self-hosted runners;
  trusted CI uses read-only repository permissions and non-persisted credentials.
- Document source-release installation and remove unverified service/trial claims.

### Migration and scope

Set TRACERY_ALLOWED_ORIGINS to exact comma-separated origins for cross-origin
browser clients, including the generator demo. Set TRACERY_PUBLIC_URL behind a
proxy whose public origin differs from the hub request origin. Native SDKs still
work without an Origin header and require keys in authenticated mode.

This release is for early testing. Stored traces may contain sensitive data;
context-redacted shares are not anonymized, and downloaded exports cannot be
revoked. npm/PyPI installs, final container SBOMs and registry publication are not
claimed by this source release. Enterprise extensions and commercial terms are
outside this repository.
