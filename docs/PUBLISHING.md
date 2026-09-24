# Publishing npm and Docker releases

Publication runs through [release.yaml](../.github/workflows/release.yaml) on
Atriarch's self-hosted runners. Use its manual **validate** operation for a dry
run, or **publish** to validate, create the version tag, and publish npm packages,
Docker images and the GitHub release in one run. Ordinary version-tag pushes
remain supported. No additional personal GitHub token is required.

## One-time account setup

Create these GitHub organization **Actions secrets**, with repository access
restricted to `Atriarch-Systems/tracery`:

| Secret | Value to obtain |
| --- | --- |
| `NPMJS_TOKEN` | An npmjs.com granular access token with read/write permission to the `@atriarch` scope and **Bypass 2FA** enabled for non-interactive publishing (see "Trusted Publishing: not available" below for why Bypass 2FA is required here). The token's owner must have publication rights to that scope. Use the shortest practical expiration and rotate it. |
| `DOCKERHUB_USERNAME` | The Docker ID of the account that owns the access token and can push to the target repository; this can differ from the organization namespace. |
| `DOCKERHUB_TOKEN` | That Docker account's access token with read/write access to the target repository. Delete permission is unnecessary. |

Create an organization or repository **Actions variable**, not a secret:

| Variable | Value |
| --- | --- |
| `DOCKERHUB_IMAGE` | The confirmed namespace and repository, for example `atriarch/tracery-hub`. Do not include a registry hostname or tag. |

The workflow creates the configured Docker Hub repository with **Public**
visibility if it does not exist. The Docker account must be allowed to create
repositories in that namespace as well as push images. An existing private
repository causes a failure; its visibility is never changed automatically.
Confirm that the `@atriarch` npm scope belongs to your account or organization.
Organization administration permissions on an npm token are not a substitute
for package/scope publication permissions.

The publication job uses its short-lived `GITHUB_TOKEN` for the tag and GitHub
release. Registry secrets are available only to that job, after all validation
jobs succeed. Do not put tokens in source files, issue comments or chat.

npm currently supports trusted publishing on GitHub-hosted runners, **not
self-hosted runners**, so this workflow uses a granular token. See the official
[npm trusted-publishing requirements](https://docs.npmjs.com/trusted-publishers/),
[npm token setup](https://docs.npmjs.com/creating-and-viewing-access-tokens/), and
[Docker access-token setup](https://docs.docker.com/security/access-tokens/).

### Trusted Publishing: not available, same reason

npm's Trusted Publishing — the CI job logging in over OIDC instead of presenting a
stored token — is what npmjs.com points you to when you create a granular token
with **Bypass 2FA** enabled, and it is the warning shown on the token creation
page. Per the [trusted-publishing requirements](https://docs.npmjs.com/trusted-publishers/)
it needs GitHub-hosted runners: "self-hosted runners are not currently supported
but are planned for future releases." This org's release workflow therefore cannot
use it, the `NPMJS_TOKEN` granular token with Bypass 2FA is the intended mechanism,
and that warning is expected. Keep the token's blast radius small:

- Scope it to the `@atriarch` scope only, never "all packages". After the first
  publish, narrow it again to the five published packages; npm allows
  package-level restriction only once the packages exist.
- Set expiration to 30–90 days and rotate on schedule.
- Store it only as the `Atriarch-Systems` organization Actions secret
  `NPMJS_TOKEN`, with repository access limited to `tracery`.
- The workflow reads it only in the publication job, after every artifact
  checksum and the `npm whoami` check.

Revisit this if the org ever adds a GitHub-hosted runner reserved for the
publication job: that would enable both Trusted Publishing and provenance
attestations.

## Release from the GitHub UI

1. Prepare the package versions and dependent ranges, update the lockfile and
   CHANGELOG, and push to `main`. Root and hub versions must agree. Require CI
   to pass. The workflow does not silently bump versions or commit changes.
2. Open **Actions → release → Run workflow**, select **main**, and leave
   **operation** as **validate**. This tests the npm packages and both native
   container architectures without creating tags, releases or registry uploads.
3. Once validation and the account setup above are complete, run the workflow
   again on **main**, select **publish**, and enter the exact prepared version
   without a `v`, for example `0.1.1`.
4. After validation and credential checks succeed, the workflow creates an
   annotated `v0.1.1` tag at the exact tested commit and a draft GitHub release.
   It publishes the tested npm tarballs and Docker images, attaches the evidence,
   and publishes the GitHub release. An existing tag must already resolve to
   that same commit; the workflow never moves it.
5. Check the release run and run the post-publication section of
   [CLEAN-MACHINE-TEST.md](CLEAN-MACHINE-TEST.md) from a clean machine. Update the
   public quick start to advertise the registry paths after they are available.

The same run performs publication because a tag created with `GITHUB_TOKEN`
does not trigger a second push workflow. See
[GitHub's event rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
You can still push a version tag yourself; it must match the prepared package
version and point to a commit on `main`'s history.

## Container architectures and tags

| Image tag (example version) | Contents |
| --- | --- |
| `0.1.1`, `latest` | Multi-platform image: Docker selects Linux AMD64 or ARM64 automatically. |
| `0.1.1-amd64`, `latest-amd64` | Linux AMD64 only. |
| `0.1.1-arm64`, `latest-arm64` | Linux ARM64 only. |

AMD64 builds and smoke tests run on `[self-hosted, Linux, X64, arc-amd64]`;
ARM64 runs on `[self-hosted, Linux, ARM64, arc-pi]`. Both the runner and Docker
daemon architecture are checked. No emulation is used. Each image gets its own
license/vulnerability/secret scan, source archive, inventory, SBOM and checksums.
Both must pass before **any** registry publication. A failed or unavailable ARM
runner blocks the release instead of silently publishing only AMD64.

ARM64 covers 64-bit Raspberry Pi systems, Apple Silicon Docker installations and
ARM cloud servers. It does not advertise support for 32-bit ARM. Combining the
verified image digests follows [Docker's multi-platform workflow](https://docs.docker.com/build/ci/github-actions/multi-platform/).
The publishing job runs on AMD64 and only loads/pushes saved ARM64 bytes; all
ARM execution and smoke testing already happened on the ARM64 runner.

## Validation and release evidence

Validation includes unit, browser, plugin and Python tests, lockfile license
policy, and release-script regression tests. `publish:check` packs core,
visualizer, client, React and hub, installs the actual tarballs into a fresh
consumer, checks imports/SSR, launches `npx tracery-hub`, and tests live tracing.
Each tarball must contain LICENSE and NOTICE; the hub must include its hosted UI
and third-party notices. Publication uses those exact tarballs with lifecycle
scripts disabled, rather than repacking them. Private workspaces are not published.

The pinned Node/Alpine containers omit unused npm/Yarn runtime tooling and include
corresponding Alpine sources. Native acceptance tests verify architecture,
non-root operation, UI/notices, source checksums, live tracing, SQLite persistence
and fail-closed authentication. Trivy rejects unreviewed licenses, source-policy
drift, secrets and HIGH/CRITICAL vulnerabilities. See [LICENSING.md](LICENSING.md)
and the [container review](../licenses/CONTAINER-REVIEW.md). GPL/LGPL operating-system
components retain their licenses and source obligations.

Actions retains `release-candidate-npm`, `release-candidate-container-amd64` and
`release-candidate-container-arm64` for 30 days. They contain the actual tarballs,
saved images and evidence, with checksums and the tested commit. The publication
job verifies all three before loading the saved images and forming the combined
manifest from immutable digests. It does not rebuild either image.

GitHub release assets include npm tarballs, source/report evidence and separately
named `container-amd64-*` and `container-arm64-*` source archives, inventories and
reports. Saved image archives remain in Actions and are distributed through Docker
Hub. `SHA256SUMS` records the original artifact paths, including those image archives.
The workflow does not publish Python/PyPI, GHCR, private enterprise images, or
deploy the hosted website.

## Retries and partial publication

Registries cannot publish atomically together. If a publication job fails, fix
the credentials or connection problem and rerun **only that failed job** from
the same Actions run. It reuses the validated artifacts. Existing tags, npm
versions, architecture images and GitHub assets must match; mismatches fail
rather than overwrite evidence. A draft release stays draft until all assets
are uploaded and both registries have been published.

If rebuilding changes bytes after any upload, prepare a new patch version.
Never move a version tag or unpublish packages to disguise a partial release.
`latest`, `latest-amd64` and `latest-arm64` are moving aliases; version tags remain
available for reproducible installs. Python, plugin and wire-contract versions
remain independent of this coordinated npm/container release.
