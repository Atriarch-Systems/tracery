# Contributing to Tracery

Tracery turns agent activity into live, inspectable graphs. Bug reports,
documentation improvements, examples, tests, and focused code changes are welcome.
You can work on the library, SDKs, plugin, or self-hosted hub without access to
Tracery Cloud or any private infrastructure.

## Before you start

Search the [issues](https://github.com/Atriarch-Systems/tracery/issues) for related
work. For a substantial feature or a public API change, open an issue describing
the problem and proposed behavior before implementing it. Small fixes can go
straight to a pull request.

Read the [README](README.md), [specification](docs/SPEC.md), and
[repository conventions](CLAUDE.md). The specification describes the event
contract; mention discrepancies between it and the implementation in your PR.

For a bug report, include the package/version, operating system, Node or Python
version, expected and actual behavior, and a minimal reproduction. Use synthetic
events. Remove credentials, prompts, customer data, private paths, and share tokens
from logs, screenshots, and exported traces before posting them.

## Local setup

Use Node.js 22.13 or newer and npm. Python SDK work uses Python 3.11, the version
tested in CI. Clone your fork and run these commands from the repository root:

```sh
npm ci
npm run build
```

Build before running tests: the JavaScript tests import compiled `dist/` files.
The workspace build order handles dependencies between the packages.

For a local demo after building:

```sh
npm run dev -w tracery-example-generator
```

Or start the hub in a separate terminal:

```sh
npm start -w @atriarch-systems/tracery-hub
```

With no `TRACERY_*` configuration, the hub listens on `127.0.0.1:8971`, uses
memory storage, and has authentication disabled. Its UI is at
`http://127.0.0.1:8971/ui/`. Use synthetic data for development; see the
[hub README](apps/hub/README.md) for authenticated and persistent deployments.

## Checks

Run the checks relevant to your change and include the results in your PR.

```sh
# Node package tests and browser tests
npx playwright install chromium
npm run build
npm test

# Claude Code plugin
npm run test:plugin
```

On Linux, Playwright may also require system packages. Its documented installer
is `npx playwright install --with-deps chromium`; installing those system
dependencies can require administrator privileges.

For a focused package check, after building the workspaces:

```sh
npm test -w @atriarch-systems/tracery-core
npm test -w @atriarch-systems/tracery-client
npm test -w @atriarch-systems/tracery-visualizer
npm test -w @atriarch-systems/tracery-react
npm test -w @atriarch-systems/tracery-hub
```

For Python, create and activate a virtual environment using your shell's normal
commands, then run:

```sh
python -m pip install -e "clients/python[dev]"
python -m pytest -q clients/python
```

For package exports, dependencies, or publishing changes:

```sh
npm run publish:check
# Also run this when changing Python packaging:
npm run publish:check:python
```

These checks create temporary consumers and exercise packaged artifacts; they
do not publish a release. The npm check currently installs the five packages
together, so also test an isolated consumer when changing a package's dependency
or type declarations. See [publishing](docs/PUBLISHING.md) and
[validation](docs/VALIDATION.md) for release checks. Docker changes should also
pass `docker build -f apps/hub/Dockerfile -t tracery-hub:dev .`.

## Code and pull requests

- Use ESM and strict TypeScript. Avoid `any` in exported APIs and do not mutate
  consumer-provided readonly inputs.
- Keep core logic independent of browser globals and React rendering. Preserve
  server-side imports for the React packages.
- Treat `packages/core/src/contract.ts` as a versioned wire contract. Contract
  changes need an explicit compatibility decision and a golden test.
- Add regression coverage for behavior changes. Control clocks and randomness
  in tests that compare animation output or generated values.
- Describe the problem, resulting behavior, and validation. Update examples and
  documentation when changing an API or configuration option.
- Keep PRs focused. Do not include generated `dist/`, credentials, captured
  telemetry, or unrelated formatting. The existing vendored build output is an
  intentional exception documented in its vendor README.

CI uses self-hosted runners. External contributions require maintainer approval
before their workflows can run; contributors do not need access to those runners.
Maintainers should review workflow and dependency-script changes before approval
and run untrusted code only on appropriately isolated infrastructure.

Discuss changes respectfully and focus feedback on the code and the problem.

## Licensing and attribution

Tracery's original code is licensed under [Apache-2.0](LICENSE). Unless explicitly
stated otherwise, contributions intentionally submitted for inclusion are under
that license, as described in its Section 5. Only contribute work you have the
right to submit, including any necessary employer authorization.

Third-party code keeps its own license. When adding or copying code, data,
images, or fonts, identify its source and version, preserve its copyright and
license notices, and describe any modifications. Include new dependencies and
their licenses in your PR description. Do not assume a public GitHub repository
or an AI-generated suggestion establishes permission to reuse source material.
See [licensing and redistribution](docs/LICENSING.md).

## Reporting a security issue

Use [GitHub's private vulnerability reporting form](https://github.com/Atriarch-Systems/tracery/security/advisories/new).
See [SECURITY.md](SECURITY.md). Do not put exploit details or private traces in public issues.

Fork PR jobs are skipped on the shared self-hosted runners. A maintainer reviews
changes before moving them to a trusted branch for CI. No response-time guarantee is implied.
