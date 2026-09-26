# Clean-machine release test

This is the acceptance run for the public community edition before npm and Docker
Hub publication. No enterprise checkout, enterprise license, npm login, Docker Hub
login, or private Atriarch infrastructure is required for the pre-publication tests.
Registry publishing is a separate maintainer step after acceptance.

## 1. Prepare the machine

Install:

- Git.
- Node.js 22, version 22.13 or newer, with npm 10 or newer. Use the latest patched
  Node 22 release to match the supported major used in CI and the container.
- Docker Desktop with **Linux containers** on Windows/macOS, or Docker Engine on
  Linux. Windows Docker Desktop needs its WSL 2 backend running.
- A current browser (Chrome, Edge, Firefox, or Safari) for the manual UI check.
- Optional: Python 3.11 for the Python SDK; Claude Code for the plugin integration.

Allow internet access to GitHub, npm, the Playwright browser download service, and
Docker Hub. For planning, allow roughly 20 GB of free disk space and 8 GB RAM;
16 GB RAM is preferable for Docker plus the browser test suite. These are testing
recommendations, not measured application minimums. Ports 4312, 18971 and 18972
should be unused. Run Docker commands as a user allowed to access its engine.

Record the output:

```sh
git --version
node --version
npm --version
docker version
```

PASS: Docker reports both a client and a running Linux server. Record OS version
and CPU architecture too. An x64 pass does not establish ARM64 support.

## 2. Fresh checkout and automated tests

Run each command separately. Stop and preserve the output on an unexpected error.
The examples work in PowerShell and a POSIX shell except where explicitly split.

```sh
git clone https://github.com/Atriarch-Systems/tracery-graph.git
cd tracery-graph
git rev-parse HEAD
npm ci
npx playwright install chromium
```

On Linux, also install Playwright's system dependencies:

```sh
npx playwright install-deps chromium
```

Then:

```sh
npm run build
npm run license:check
npm test
npm run test:plugin
npm run publish:check
```

PASS:

- Build and license policy exit 0.
- Unit tests and browser tests pass with zero failures. Record skipped tests;
  an unavailable Docker/Postgres test must not be counted as a pass.
- Plugin tests pass. Claude Code itself is not needed for these automated tests.
- `publish:check` ends with `ALL CHECKS PASSED` (currently 13/13). It packs all
  five packages, installs them into an isolated consumer, checks imports and
  React rendering, starts the packaged CLI/UI, and verifies live parent/child
  traces. It removes its temporary consumer and stops its hub when finished.

This proves tarball installation, not registry availability. Check the
published package separately with `npx @atriarch-systems/tracery-hub` and
record it as "Public npm install" in the report.

## 3. Manual explorer check

```sh
npm run preview -w tracery-example-embedded
```

Open <http://localhost:4312/>. While synthetic events are arriving:

- Select a child flow and use **With ancestors**.
- Drag groups apart. Later events must preserve the manual positions.
- Switch scopes away and back; positions should remain during that explorer
  session. Reloading the page is allowed to reset them.
- Check node inspection, fit/zoom, and light/dark appearance.
- Open **Open-source licenses** and confirm readable third-party text.

Record PASS/FAIL and stop the preview with Ctrl-C.

## 4. Build and run the actual container

From the repository root:

```sh
docker build -f apps/hub/Dockerfile -t tracery-release-test:local .
docker image inspect tracery-release-test:local --format "{{.Id}} {{.Os}}/{{.Architecture}}"
docker volume create tracery-release-test-data
docker run -d --name tracery-release-test -p 127.0.0.1:18971:8971 -e TRACERY_AUTH=none -e TRACERY_STORE=sqlite -v tracery-release-test-data:/data tracery-release-test:local
```

The explicit auth opt-out is only for this loopback-bound synthetic-data test.
Wait for startup, then open these in a browser:

- <http://127.0.0.1:18971/healthz>: HTTP 200, status `ok`.
- <http://127.0.0.1:18971/v1/info>: community edition, auth `none`.
- <http://127.0.0.1:18971/ui/>: actual explorer, no missing-build page or login prompt.

Check identity and bundled notices:

```sh
docker exec tracery-release-test id
docker exec tracery-release-test ls -l /app/LICENSE /app/NOTICE /app/THIRD-PARTY-NOTICES.txt
```

PASS: the app runs as a non-root user and all three notice files exist.

Emit a synthetic trace using the same acceptance fixture as the npm check.
In PowerShell:

```powershell
$env:TRACERY_HUB_URL = 'http://127.0.0.1:18971'
node scripts/publish-check-demo.template.mjs
Remove-Item Env:TRACERY_HUB_URL
```

In bash/zsh:

```sh
TRACERY_HUB_URL=http://127.0.0.1:18971 node scripts/publish-check-demo.template.mjs
```

PASS: the fixture ends `ALL CHECKS PASSED` (4/4). Open the trace in the UI and
note its flow IDs. Restart, then reload:

```sh
docker restart tracery-release-test
```

PASS: the same flows and events remain after restart (SQLite persistence).
From a flow, export HTML and PNG. The PNG must contain the graph; the HTML must
open from disk with the graph and license disclosure, even with the hub stopped.
Create a share link, open it in a private browser window, then revoke it; reloading
the link must deny access. The browser suite in step 2 checks live-share expiry
and revocation in more detail.

## 5. Verify the container fails closed

```sh
docker run --name tracery-auth-default-test tracery-release-test:local
docker inspect tracery-auth-default-test --format "{{.State.ExitCode}}"
```

PASS: startup fails, exits nonzero, and explains that a non-loopback bind needs
API keys or an explicit auth opt-out. This failure is expected.

The automated hub and browser tests cover key authentication, workspace isolation,
hostile origins and share authorization. Record their results from step 2; do not
replace that suite with the manual startup check.

## 6. Final artifact review (maintainer)

Before upload, inspect the five actual npm tarballs: compiled JS and declarations,
README, LICENSE, NOTICE, and the hub's hosted/offline UI plus generated third-party
notices must be present. No credentials or enterprise source should ship.

Generate a final-image SBOM and scan that image for vulnerabilities, license
obligations and secrets using Trivy. Review findings, including base-OS components;
a passing source-lockfile policy is not a final-image audit. Retain image ID,
platform, reports, and tarball hashes with the release evidence. Test each CPU
architecture that the published manifest claims to support.

## 7. Public-registry round trip (after publication only)

Use a fresh directory outside the source checkout. Confirm the package/image tags
were actually published before this step. Use the final version/namespace if it
changed during release preparation.

```sh
npx --yes @atriarch-systems/tracery-hub@0.1.1
```

PASS: <http://127.0.0.1:8971/ui/> loads from the registry-installed package. Stop
with Ctrl-C. Then, on a machine without a locally built image under this tag:

```sh
docker pull atriarchsystems/tracery-hub:0.1.1
docker run --rm -p 127.0.0.1:18972:8971 -e TRACERY_AUTH=none atriarchsystems/tracery-hub:0.1.1
```

PASS: <http://127.0.0.1:18972/ui/> works. Record the pulled digest and architecture.
An npm E404 or Docker image-not-found is a publication/name/access failure, not a
reason to switch networks. Do not claim registry installation passed based only
on the local build or `publish:check`.

## 8. Report and cleanup

Copy and complete:

```text
OS / CPU:
Node / npm / Docker versions:
Source commit:
Build + license policy: PASS / FAIL
Unit + browser tests: PASS / FAIL (skipped tests: ...)
Plugin automated tests: PASS / FAIL
npm tarball check: PASS / FAIL
Manual With ancestors placement: PASS / FAIL
Container image ID / architecture:
Container startup + UI + notices + non-root user: PASS / FAIL
Container ingest + live traces + SQLite restart: PASS / FAIL
Exports + share revocation: PASS / FAIL
Container no-keys startup rejected: PASS / FAIL
Final tarball review + image scans: PASS / FAIL / NOT RUN
Public npm install: PASS / FAIL / NOT PUBLISHED
Public Docker pull: PASS / FAIL / NOT PUBLISHED
Failure output / screenshots:
```

Stop and remove only the test containers you created:

```sh
docker rm -f tracery-release-test tracery-auth-default-test
```

Keep `tracery-release-test-data` until the persistence result is recorded. Remove
it only if you want to discard this test's synthetic data:

```sh
docker volume rm tracery-release-test-data
```

Optional Python SDK and real Claude Code sessions can be tested separately using
`clients/python/README.md` and `plugins/claude-code/README.md`. Neither is required
to establish the npm and Docker installation paths above.
