# Publishing

Exact steps to take Tracery from "builds and tests pass in this checkout" to
"a stranger can `npm install` / `pip install` / `docker pull` it." Nothing
here has been published yet as of this writing: no `@atriarch` package
exists on npmjs.com, `atriarch-tracery` is unclaimed on PyPI, and there is no
`atriarch/tracery-hub` image on Docker Hub or GHCR. This document is the
runbook for doing all four (npm, PyPI, Docker, GitHub) for the first time and
every time after.

See [`docs/VALIDATION.md`](VALIDATION.md) for how an agent should verify a
fresh checkout end to end (a prerequisite to publishing, not a substitute for
this document), and [`scripts/publish-check.mjs`](../scripts/publish-check.mjs)
/ [`scripts/publish-check-python.mjs`](../scripts/publish-check-python.mjs)
for the automated proof described in "What `publish:check` proves" below.

## Pre-publish checklist

Run this before every publish, first time or the hundredth:

- [ ] `npm ci && npm run build && npm test && npm run test:plugin` all pass from a clean tree.
- [ ] `npm run publish:check` passes (builds, packs all five npm packages, installs the tarballs into a throwaway project, and exercises them -- see below).
- [ ] `npm run publish:check:python` passes (builds the wheel, installs it into a fresh venv, imports it).
- [ ] Every package's version has been bumped if this is a real release (see "Versioning" below) -- publishing an already-published version number fails outright, which is the safety net, not a step to route around.
- [ ] `npm pack --dry-run` reviewed for each of the five packages (see "Review before publishing" below) -- no `.env`, no `keys.json`, no `node_modules`, no test fixtures with real-looking secrets.
- [ ] `git status --short` is clean, or you know exactly what's uncommitted and why.
- [ ] You are on the commit you intend to tag as this release.

## npmjs.com

### One-time setup

1. **Create the account.** [npmjs.com/signup](https://www.npmjs.com/signup) if Atriarch Systems does not already have one. Use an email you control long-term -- this account will own the `@atriarch` scope forever unless transferred.
2. **Claim the `@atriarch` scope.** Scopes are claimed implicitly by publishing the first package under them, or explicitly by creating an "Organization" named `atriarch` in the npmjs.com UI (Organizations → Create Organization). An organization is worth doing even for a single maintainer: it lets you add teammates later without transferring account ownership, and it's how `publishConfig.access: "public"` scoped packages are billed (free for public packages). Nothing under `@atriarch` exists yet as of this writing, so this claim will succeed cleanly -- if it doesn't, someone else got there first and every `"name"` in this repo's five `package.json` files needs to change.
3. **Enable 2FA.** Account → Settings → Two-Factor Authentication, set to "Authorization and Publishing" (not just "Authorization only") -- npm has required 2FA for publishing scoped packages for years, and this is not optional for a real publish.
4. **Create a granular access token.** Account → Access Tokens → Generate New Token → Granular Access Token:
   - Scope it to the `@atriarch` organization/scope only, not "all packages."
   - Permissions: "Read and write."
   - Expiry: pick something you'll actually rotate (90 days is reasonable); granular tokens can also be restricted to specific packages once they exist, which is worth tightening on the second publish.
   - Save the token value immediately -- it is shown once. Store it in whatever secret manager this environment uses (OpenBao, a CI secret, etc.), never in a file in this repo.
5. **`npm login`** locally (or `npm config set //registry.npmjs.org/:_authToken <token>` for CI, which is the non-interactive equivalent and what a CI runner should actually use):
   ```sh
   npm login
   ```
   This prompts for username/password/email and a 2FA code if 2FA is set to "Authorization and Publishing." Verify with `npm whoami`.

### Publish order

The five packages depend on each other (`packages/react` depends on `packages/core`, `packages/visualizer`, and `packages/client`; `apps/hub` depends on `packages/core`), and every internal dependency in this repo is pinned to a real semver range (`^0.1.0`, `^0.3.0` for the visualizer -- see `CLAUDE.md` and each package's `package.json`), never `"*"`. Publish in dependency order so that by the time a package's own dependents publish, the range they already declare resolves against something real on the registry:

```
1. packages/visualizer   (@atriarch/tracery-visualizer)
2. packages/core         (@atriarch/tracery-core)
3. packages/client       (@atriarch/tracery-client)
4. packages/react        (@atriarch/tracery-react)
5. apps/hub              (@atriarch/tracery-hub)
```

(`apps/hub/web` is `"private": true` and is never published on its own --
its build output ships *inside* the `@atriarch/tracery-hub` tarball, at
`web/dist`, via that package's `files` array and its `prepack` script; see
"The hub's hosted UI" below.)

From each package's own directory:

```sh
cd packages/visualizer && npm publish --access public
cd ../core              && npm publish --access public
cd ../client            && npm publish --access public
cd ../react             && npm publish --access public
cd ../../apps/hub       && npm publish --access public
```

`--access public` is required the first time any scoped package publishes
(npm defaults scoped packages to private, which would otherwise fail against
a free account/org); every `package.json` in this repo already carries
`"publishConfig": { "access": "public" }`, so `--access public` is technically
redundant after the first publish but harmless and worth keeping in muscle
memory.

Equivalently, from the repo root, `npm publish -w <package-name>` publishes
one workspace without `cd`-ing into it:

```sh
npm publish -w @atriarch/tracery-visualizer --access public
npm publish -w @atriarch/tracery-core --access public
npm publish -w @atriarch/tracery-client --access public
npm publish -w @atriarch/tracery-react --access public
npm publish -w @atriarch/tracery-hub --access public
```

Both `npm publish` and `npm pack` run each package's `prepack` script first
(`npm run build`, plus `apps/hub`'s extra `node scripts/ensure-ui.mjs` step --
see below), so a fresh, unbuilt checkout still produces a correct tarball;
you do not need to `npm run build` immediately beforehand, though the
pre-publish checklist above has you do it anyway as part of the test run.

### The hub's hosted UI

`@atriarch/tracery-hub`'s `bin/hub.mjs` serves the hosted explorer from
`web/dist` next to its own `dist/` (`apps/hub/src/config.ts`'s
`defaultUiDir()`), so the published tarball must contain a built
`apps/hub/web/dist`, not just the hub server's own compiled output.
`apps/hub/package.json`'s `files` array includes `"web/dist"`, and its
`prepack` script (`npm run build && node scripts/ensure-ui.mjs`) builds the
hosted UI from the repo root when `web/dist` doesn't already exist --
so `npm publish` (or `npm pack`) for `apps/hub` from a clean checkout where
nobody ran the monorepo's own `npm run build` first still ships a working
UI. `apps/hub/scripts/ensure-ui.mjs` writes all of its own output to stderr,
never stdout, specifically so it doesn't corrupt `npm pack --json` /
`npm publish --json`'s machine-readable output (this is what
`scripts/publish-check.mjs` relies on to find the tarball it just packed).

### Versioning

All five packages are pinned to real semver ranges against each other
(never `"*"`), so a version bump to one that other packages depend on means
bumping those dependents' declared range too if you want them to pick up the
change on their next publish -- npm will not do this automatically.

- Bump each package's own `"version"` in its `package.json` (`npm version
  patch|minor|major` run from inside that package's directory works, but
  touches git tags per-package in a workspace -- editing the field directly
  and committing normally is simpler in this layout).
- If `packages/core` goes to `0.2.0` and you want `packages/client`,
  `packages/react`, and `apps/hub` to require it, bump their
  `"@atriarch/tracery-core"` dependency range too (to `^0.2.0`, or whatever
  the new floor should be) before publishing them.
- `packages/react`'s dependency on `@atriarch/tracery-visualizer` uses
  `^0.3.0` (the visualizer is ahead of the other packages at `0.3.0` already)
  -- keep that in sync the same way if the visualizer bumps.
- Semver matters here in the ordinary way: a breaking change to
  `packages/core/src/contract.ts` (the wire contract) is a major bump on
  `packages/core` and forces a coordinated major bump through everything
  that re-exports or depends on the changed shape.

### Review before publishing

`npm pack --dry-run` from each package's directory prints exactly what would
be tarballed without writing a file -- run it and actually read the file
list, every time, especially after touching a package's `files` array or
adding a new source file that should (or shouldn't) ship:

```sh
cd packages/core && npm pack --dry-run
```

Look for: no `node_modules`, no `.env*`, no `tests/` unless intended, no
`keys.json`/`keys.example.json` (hub only -- those belong in the Docker/k8s
paths, not the npm tarball), and for `apps/hub` specifically, confirm
`web/dist/index.html` and `web/dist/assets/*` are present (the whole point
of the `prepack` step above).

### What `publish:check` proves

`npm run publish:check` (`scripts/publish-check.mjs`) is the automated
version of "does this actually work once it leaves the workspace," and is
the reason the internal `"*"` dependencies were replaced with real ranges in
the first place -- a tarball install resolves those against the registry (or,
here, against the other tarballs installed alongside it), and `"*"` cannot
be satisfied by anything real. It:

1. Runs `npm run build` for the whole monorepo.
2. `npm pack`s all five packages into a scratch directory.
3. Creates a brand-new temp project (its own `package.json`, no relation to
   this repo) and `npm install`s all five tarballs into it **at once**, so
   `@atriarch/tracery-core`, etc. resolve against each other's tarball
   instead of ever touching the npm registry.
4. From that temp project, using only the installed packages (no workspace
   imports, no relative paths back into this repo):
   - imports `@atriarch/tracery-core` and `@atriarch/tracery-client`
     directly;
   - server-renders `@atriarch/tracery-react`'s `ActivityExplorer` (which
     pulls in `@atriarch/tracery-visualizer`) over `tracery-core`'s own
     fixtures via `react-dom/server`, the same pattern
     `packages/react/tests/explorer-ssr.test.mjs` uses against workspace
     `dist/`;
   - runs `npx tracery-hub` with no env beyond a random port, and confirms
     `GET /v1/info` reports `auth: "none"` and `GET /ui/` serves the real
     hosted UI (not the "UI not built" placeholder);
   - runs a from-tarballs equivalent of `scripts/demo.mjs` against that hub
     (a parent flow spawning two child flows, resolved into one trace,
     observed live over `WS /v1/live`).
5. Prints PASS/FAIL per step and cleans up everything (the temp project, the
   tarballs, the hub process) regardless of outcome.

A green `publish:check` means: the five tarballs' internal dependencies
resolve to each other correctly, every package's public API is importable
from a real install, the hub's bin script and hosted UI both work from an
installed tarball (not just from the workspace), and the whole
producer→hub→graph pipeline functions end to end -- everything short of an
actual registry round-trip. Run it before every publish.

## PyPI

### One-time setup

1. **Create the account.** [pypi.org/account/register](https://pypi.org/account/register/) if Atriarch Systems doesn't have one. Enable 2FA (Account settings → Two-factor authentication) -- PyPI has required 2FA for new/high-download packages for a while and will likely require it here too.
2. **Claim the name.** `atriarch-tracery` is unclaimed as of this writing; the first successful upload claims it. There is no separate "reserve the name" step on PyPI the way npm scopes work -- claiming happens at publish time.
3. **Create an API token.** Account settings → API tokens → Add API token. For the very first publish the token must be account-scoped (project-scoped tokens can only be created for projects that already exist on PyPI). Immediately after the first successful publish, create a second, project-scoped token restricted to `atriarch-tracery` and delete the account-scoped one -- least privilege for every publish after the first.
4. **Install the tooling** (once per machine/environment):
   ```sh
   python -m pip install build twine
   ```

### Build and upload

```sh
cd clients/python
python -m build          # writes dist/atriarch_tracery-<version>-py3-none-any.whl and the sdist
python -m twine check dist/*      # validates README rendering, metadata -- catches most mistakes before upload
python -m twine upload dist/*
```

`twine upload` prompts for a username and password; use `__token__` as the
username and the full `pypi-...` token (including the `pypi-` prefix) as the
password. Non-interactively (CI), set `TWINE_USERNAME=__token__` and
`TWINE_PASSWORD=<token>` as env vars instead.

`scripts/publish-check-python.mjs` (`npm run publish:check:python`) proves
the build + install path works (see "What `publish:check` proves" above; the
Python sibling script installs the built wheel into a fresh venv and imports
it) but does **not** upload anything -- run it before every PyPI publish the
same way you run `publish:check` before every npm publish, and run
`python -m twine upload` yourself, deliberately, afterward.

### Versioning

Bump `"version"` in `clients/python/pyproject.toml`. PyPI (unlike npm) has no
`--force`-style override for re-publishing an existing version under any
circumstances, including a yanked one -- get the version number right before
uploading, not after.

## Docker

The hub's image builds from the **repository root** (it needs
`packages/core`'s source and, for the hosted UI, `apps/hub/web`), not from
`apps/hub/`:

```sh
docker build -f apps/hub/Dockerfile -t atriarch/tracery-hub:latest -t atriarch/tracery-hub:<version> .
```

Tag with both `latest` and the exact `apps/hub` version (e.g. `0.1.0`) so a
consumer can pin. Smoke-test the built image before pushing anywhere:

```sh
docker run --rm -p 127.0.0.1:8971:8971 -e TRACERY_AUTH=none atriarch/tracery-hub:<version>
curl http://127.0.0.1:8971/v1/info    # {"auth":"none", ...} -- explicit local testing opt-out, see apps/hub/README.md
```

### Docker Hub

```sh
docker login                      # once per machine; needs a Docker Hub account + access token
docker push atriarch/tracery-hub:latest
docker push atriarch/tracery-hub:<version>
```

The repository `atriarch/tracery-hub` must exist on Docker Hub first (Docker
Hub → Create Repository) unless the account has permission to
auto-create on first push -- check before the first release rather than
finding out mid-`push`.

### GHCR (GitHub Container Registry)

Once the repo is on GitHub (see below), the same image can also publish to
`ghcr.io/atriarch-systems/tracery-hub`:

```sh
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
docker tag atriarch/tracery-hub:<version> ghcr.io/atriarch-systems/tracery-hub:<version>
docker tag atriarch/tracery-hub:<version> ghcr.io/atriarch-systems/tracery-hub:latest
docker push ghcr.io/atriarch-systems/tracery-hub:<version>
docker push ghcr.io/atriarch-systems/tracery-hub:latest
```

`GITHUB_TOKEN` here needs `write:packages` scope. Pushing both Docker Hub and
GHCR is redundant for most users but costs little and covers whichever
registry a given consumer's pull-through cache or firewall rules allow.

## GitHub

1. **Push this repository** to `github.com/atriarch-systems/tracery` (public). Every doc in this repo (`README.md`, `docs/CLAUDE-CODE-PLUGIN.md`, `.claude-plugin/marketplace.json`, etc.) already assumes this exact `owner/repo` -- it is not a placeholder to swap later, it is where this repo is meant to live.
2. **Add topics** (repo → About → gear icon → Topics) for discoverability: `observability`, `agents`, `llm`, `ai-agents`, `tracing`, `claude-code`, `mcp` (whichever actually apply -- keep this list honest, don't cargo-cult tags nobody searches).
3. **Set the repo description and homepage URL** in the same "About" panel -- the homepage URL should point at wherever the project's own site/docs land, or back at the README if there isn't one yet.
4. **The Claude Code plugin marketplace goes live the moment this push happens.** `.claude-plugin/marketplace.json` already declares `"source": "./plugins/claude-code"` and every URL in it already points at `atriarch-systems/tracery` -- there is no separate publish step for the plugin. The instant the repo exists at that path on GitHub, `/plugin marketplace add atriarch-systems/tracery` works for anyone. Double-check `plugins/claude-code/README.md` and `docs/CLAUDE-CODE-PLUGIN.md` no longer need their "intended future location" hedging once this is true.
5. **Tag the release** (`git tag v0.1.0 && git push --tags` or via GitHub's Releases UI) after the npm/PyPI/Docker publishes above succeed, not before -- the tag should point at the exact commit that was actually published everywhere.

### Provenance attestations: off, on purpose

`npm publish --provenance` and GitHub Actions' `actions/attest-build-provenance`
both require the publish to run on a **GitHub-hosted** Actions runner (the
attestation is signed using the runner's OIDC identity, which self-hosted
runners don't have). `docs/CLAUDE-CODE-PLUGIN.md`'s CI and every workflow in
this org run on self-hosted runners exclusively (`CLAUDE.md`: "CI runs on
self-hosted runners only. Never `runs-on: ubuntu-latest`."), so provenance
attestations are not available for these packages and every publish above is
manual, from a maintainer's machine, with `npm publish --provenance` simply
never invoked. Publishes still carry npm's ordinary registry-level
integrity guarantees (signed metadata, `npm audit signatures`); they just
don't get the "Provenance" badge on the npmjs.com package page. Revisit this
if the org ever stands up a GitHub-hosted runner for release publishing
specifically (nothing else needs to move to one).
