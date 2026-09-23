# Publishing npm and Docker releases

Publication runs through [release.yaml](../.github/workflows/release.yaml) on
Atriarch's self-hosted Linux x64 runners. A manual run validates without
publishing. Pushing a new stable `v0.x.y` tag runs the same checks and then
publishes the tested artifacts. The tag must match the root and hub versions,
and its commit must be on the history of `main`.

The existing `v0.1.0` is a GitHub source release. Registry publication is still
pending. The next coordinated candidate is `v0.1.1`; the independently versioned
visualizer is `0.3.1`. Do not move the old source-release tag.

## One-time organization setup

Create these **GitHub organization Actions secrets**, with repository access
restricted to `Atriarch-Systems/tracery`:

| Secret | Value to obtain |
| --- | --- |
| `NPM_TOKEN` | An npm granular access token with read/write permission to the `@atriarch` scope and **Bypass 2FA** enabled for non-interactive publishing. The token's owner must have publication rights to that scope. Use the shortest practical expiration and rotate it. |
| `DOCKERHUB_USERNAME` | The Docker ID of the account that owns the access token and can push to the target repository; this can differ from the organization namespace. |
| `DOCKERHUB_TOKEN` | That Docker account's access token with read/write access to the target repository. Delete permission is unnecessary. |

Create an organization or repository **Actions variable**, not a secret:

| Variable | Value |
| --- | --- |
| `DOCKERHUB_IMAGE` | The confirmed namespace and repository, for example `atriarch/tracery-hub`. Do not include a registry hostname or tag. |

Create that Docker Hub repository with **Public** visibility before the first
release. Confirm that the `@atriarch` npm scope belongs to your account or
organization; lack of existing public packages does not prove a scope is free.
Organization administration permissions on an npm token are not a substitute
for package/scope publication permissions.

No personal GitHub token is needed: the publication job uses its short-lived
`GITHUB_TOKEN` for GitHub release assets. The workflow receives registry secrets
only in the publication job, after validation succeeds. Do not put tokens in
source files, issue comments or chat.

npm currently supports trusted publishing on GitHub-hosted runners, **not
self-hosted runners**, so this workflow uses a granular token. See the official
[npm trusted-publishing requirements](https://docs.npmjs.com/trusted-publishers/),
[npm token setup](https://docs.npmjs.com/creating-and-viewing-access-tokens/), and
[Docker access-token setup](https://docs.docker.com/security/access-tokens/).

## Release procedure

1. Bump the packages that changed, their dependent ranges where needed, and the
   corresponding workspace entries in `package-lock.json`. Keep the root and hub
   version aligned. Update CHANGELOG.md. Python, plugin and wire-contract
   versions are separate and are not automatically published by this workflow.
2. Push the reviewed commit to `main`. Require normal CI to pass.
3. In GitHub Actions, run **release → Run workflow** against `main`. This dry run
   performs the release checks without registry credentials or publication.
4. Once that run passes and the settings above exist, push a new annotated tag
   matching the prepared version, for example `v0.1.1`. Tag pushes publish; do
   not use them to test workflow changes.
5. Inspect the release run. Confirm all five npm packages and the versioned
   Docker image are publicly retrievable. Run the post-publication section of
   [CLEAN-MACHINE-TEST.md](CLEAN-MACHINE-TEST.md), then update the public quick
   start to advertise the now-available registry paths.

The first Docker release targets `linux/amd64`. ARM64 must be built, scanned and
smoke-tested separately before advertising support.

## What is checked and published

Validation includes the repository unit, browser, plugin and Python tests,
lockfile license policy, and release-gate regression tests. `publish:check`
builds and packs core, visualizer, client, React and hub, installs their tarballs
into a fresh consumer, checks imports/SSR, launches `npx tracery-hub`, and tests
live trace ingestion. Each tarball must contain LICENSE and NOTICE; the hub must
also contain its hosted UI and third-party notices.

With `TRACERY_RELEASE_DIR` set, the checker retains those exact passing tarballs
and their file lists, npm integrity values and SHA-256 hashes. Publication uses
them in dependency order with lifecycle scripts disabled; it does not repack or
rebuild them. Private workspaces are never published independently.

The Docker build pins its upstream Node/Alpine images, omits unused npm/Yarn
runtime tooling, and includes the Alpine corresponding-source archive inside
its final image. The acceptance script checks non-root operation, UI/notices,
source-archive checksums, live tracing, SQLite persistence and fail-closed
network authentication. Trivy scans the actual image for vulnerabilities,
licenses and secrets. Unreviewed licenses, missing inventories, source-policy
drift, secret findings and HIGH/CRITICAL vulnerabilities block publication.

See [LICENSING.md](LICENSING.md) and the detailed
[container review](../licenses/CONTAINER-REVIEW.md). Operating-system GPL/LGPL
components retain their own licenses and source obligations; they are not
silently relabeled Apache-2.0.

The release-candidate Actions artifact retains the exact npm tarballs, saved
Docker image, source archive, inventories, source and image CycloneDX SBOMs,
scan reports, source commit and checksums. The publication job checks these
checksums and publishes the saved image without rebuilding. GitHub release
assets include the evidence and source archive; the large saved image remains
in Actions for 30 days and is distributed through Docker Hub. The SHA256SUMS
file also describes that Actions-only image archive.

The workflow publishes the five npm packages, Docker tags `VERSION` and
`latest`, and GitHub release assets. It does not publish to PyPI, GHCR, a private
enterprise registry, or deploy the hosted website.

## Retries and partial publication

npm and Docker are separate registries; a release cannot be atomic across them.
If publication fails, correct the account/connection problem and rerun the
failed **publication job** from the same workflow run. It reuses the validated
artifacts. Matching npm versions and Docker image configurations can be reused;
an existing version with different bytes is rejected. Existing GitHub evidence
must match byte-for-byte. Never overwrite a tag or unpublish packages to disguise
a partial release.

If rebuilding changes artifact bytes after any registry upload, prepare a new
patch version. For a successful release, npm's `latest` and Docker's `latest`
refer to the published stable candidate. Keep versioned tags available for
reproducible installs.
