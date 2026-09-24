# Validation

For an AI coding agent that has just cloned this repository on a machine you
know nothing about. Follow this document top to bottom, in order, without
opening any other file in this repo unless a step tells you to. Every step
names an exact command, what you should observe, and a PASS/FAIL line to
fill in. Fill in every line as you go — don't wait until the end and
reconstruct it from memory.

If a step's observed result doesn't match, that is a real bug (a missing
committed file, a gitignored artifact the build needed, an absolute path, an
undeclared dependency) worth reporting exactly as seen, not worked around
silently.

## 0. Environment check

Run each of these and record the version. Node and npm are required for
every track below; Python and Docker gate their own tracks only; Claude Code
gates track 3 only.

```sh
git --version                 # any recent git
node --version                # need >= 22.13
npm --version                 # need >= 10
python --version || python3 --version   # optional; need >= 3.11 if present, gates track 1's Python-client checks (there are none) and nothing else -- Python only matters for clients/python, which this document's three tracks don't touch directly
docker --version              # optional; gates the Docker half of track 2
claude --version              # optional; gates track 3 entirely
```

If Node is older than 22.13, stop here — `node:sqlite` (used by the hub's
default local-mode store) and other runtime features require it, and
everything below will fail in confusing ways rather than a clear version
error.

**Environment check: PASS / FAIL** ______

## 1. npm library track

Proves the "library" and "both" usage modes from the root README: the core
event model, the React explorer, and the packaged tarballs a real `npm
install` would pull down.

### 1.1 Install and build

```sh
npm ci
npm run build
```

Observe: both commands exit 0. `npm run build` prints one `tsc -p
tsconfig.json` line per package (`tracery-visualizer`, `tracery-core`,
`tracery-client`, `tracery-react`, `tracery-hub`), then a `vite build` for
`tracery-hub-web` (two builds: the hosted UI and the standalone HTML-export
viewer), then a `vite build` for `tracery-example-embedded`. No red/error
output from any step.

**1.1 install + build: PASS / FAIL** ______

### 1.2 Run the tests

```sh
npm test
npm run test:plugin
```

Observe: `npm test` runs `node --test` for five packages plus a Playwright
suite for `tracery-hub-web` (all in-process against a hub Playwright starts
itself — nothing to configure). Every package prints `# fail 0` at the end
of its `node --test` output; the Playwright run prints `N passed` with zero
failed/flaky. `npm run test:plugin` runs `node --test
plugins/claude-code/tests/*.test.mjs` and also ends `# fail 0`.

If Playwright reports missing browsers (an error mentioning
`browserType.launch` or "Executable doesn't exist"), install them once and
re-run:

```sh
npx playwright install chromium
npm test
```

**1.2 npm test + test:plugin: PASS / FAIL** ______

### 1.3 The embedded example (`vite preview`)

```sh
npm run preview -w tracery-example-embedded
```

Observe: prints a local URL, normally `http://localhost:4312/`. Open it (or,
headless, `curl -s http://localhost:4312/ | grep -o '<title>[^<]*'`) and
confirm the page loads. In a browser: a full-screen graph explorer under a
one-line header reading "Tracery embedded example: no hub, no network."
Within a couple of seconds a flow labeled "Plan the investigation" appears
and animates (nodes pulse while running); a few seconds later two more flows
spawn from its search node. This is `docs/DEMOS.md`'s "npm library (no
server)" demo — no hub, no network calls, pure in-browser `Journal`. Stop
the preview server (Ctrl-C) when done.

**1.3 embedded example animates: PASS / FAIL** ______

### 1.4 The tarball path (`publish:check`)

Proves the five published packages actually work once installed from a
tarball instead of the workspace — see
[`docs/PUBLISHING.md`](PUBLISHING.md) "What `publish:check` proves" for the
full explanation of each step.

```sh
npm run publish:check
```

Observe: a `--- 0. build ---` through `--- 3c. demo ---` section, each with
PASS lines, ending in `13/13 checks passed` and `ALL CHECKS PASSED`. This
takes a minute or two (it builds everything, packs five tarballs, installs
them into a throwaway project, and runs a hub + a mini end-to-end demo
against it) and cleans up its own scratch directory when done, pass or fail.

**1.4 publish:check: PASS / FAIL** ______

## 2. Self-hosted hub track

Proves the "hub" and "sharing" usage modes: a standalone server multiple
producers push to, viewed through its own hosted UI.

### 2.1 Run with no configuration

```sh
node apps/hub/bin/hub.mjs
```

Observe: a log line `Tracery hub: http://127.0.0.1:8971  (local mode, no
auth; ...)` and `store: memory`. Leave it running in this terminal; open a
second terminal for the rest of this section.

```sh
curl -s http://127.0.0.1:8971/v1/info
```

Observe: `{"product":"tracery","version":"...","edition":"community","auth":"none","workspace":"default"}`.

```sh
curl -s http://127.0.0.1:8971/ui/ | grep -o '<title>[^<]*'
```

Observe: `<title>Tracery`. If instead you see a page mentioning "UI not
built," the hosted UI (`apps/hub/web`) was never built — run `npm run build
-w @atriarch-systems/tracery-hub-web` (needs `@atriarch-systems/tracery-core`,
`@atriarch-systems/tracery-client`, `@atriarch-systems/tracery-react`,
`@atriarch-systems/tracery-visualizer` already built first, or just `npm run build`
from the repo root) and retry.

**2.1 no-env hub + /v1/info + /ui/: PASS / FAIL** ______

### 2.2 `scripts/demo.mjs`

With the hub from 2.1 still running:

```sh
node scripts/demo.mjs
```

Observe: `[demo] ALL CHECKS PASSED` and `9/9 checks passed` just above it.
This spawns a Python subprocess for one of its three flows
(`scripts/demo_child.py`) — if it fails with `ModuleNotFoundError: No module
named 'atriarch'`, the `python` on your `PATH` doesn't have `atriarch-tracery`
installed; either `pip install -e clients/python[dev]` into whatever
interpreter `python` resolves to, or point the script at one that already
has it: `PYTHON=/path/to/venv/bin/python node scripts/demo.mjs`. This is an
environment/PATH detail, not a bug in the demo script.

Stop the hub from 2.1 (Ctrl-C in its terminal) once this passes.

**2.2 demo.mjs against the no-env hub: PASS / FAIL** ______

### 2.3 Docker path

```sh
docker build -f apps/hub/Dockerfile -t atriarch/tracery-hub:validate .
docker run --rm -d --name tracery-hub-validate -p 127.0.0.1:18971:8971 -e TRACERY_AUTH=none atriarch/tracery-hub:validate
```

(Port `18971` here is arbitrary and chosen to avoid colliding with anything
already using `8971` on this machine — use any free port.) Wait a couple of
seconds for the container's healthcheck to pass, then repeat the same
checks as 2.1 and 2.2 against it:

```sh
curl -s http://127.0.0.1:18971/v1/info      # same shape as 2.1
curl -s http://127.0.0.1:18971/ui/ | grep -o '<title>[^<]*'
TRACERY_HUB_URL=http://127.0.0.1:18971 node scripts/demo.mjs
```

Observe the same results as 2.1/2.2. Then:

```sh
docker stop tracery-hub-validate
```

**2.3 Docker build + run + same checks: PASS / FAIL** ______

### 2.4 A share link, fetched with no key

Start a hub in local mode again if you stopped it (`node apps/hub/bin/hub.mjs`
in a spare terminal), run `node scripts/demo.mjs` against it once to have a
real flow to share, then:

```sh
FLOW_ID=$(curl -s http://127.0.0.1:8971/v1/flows | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).flows[0].id))")
curl -s -X POST http://127.0.0.1:8971/v1/shares \
  -H 'content-type: application/json' \
  -d "{\"target\":{\"type\":\"flow\",\"id\":\"$FLOW_ID\"},\"mode\":\"snapshot\",\"includeContext\":false}"
```

(No `authorization` header above — a local-mode hub needs no API key at
all; against a hub configured with `TRACERY_API_KEYS`, add `-H "authorization:
Bearer <a read-role key>"`.) Observe a JSON body with `"url"` shaped like
`http://127.0.0.1:8971/s/<token>`. Fetch that URL with a plain,
unauthenticated request:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "<the url from above>"
```

Observe `200`, with no key, header, or cookie sent — this is the entire
point of a share link (`docs/SHARING.md`).

**2.4 share link created and fetched with no key: PASS / FAIL** ______

## 3. Claude Code plugin track

Proves the plugin turns a real Claude Code session into a live flow graph on
a hub. Requires `claude` on `PATH`. Skip this track (mark N/A, not FAIL) if
it is not installed.

### 3.1 Start a hub

```sh
node apps/hub/bin/hub.mjs
```

Leave it running (local mode, no key needed — see track 2).

### 3.2 Start a Claude Code session with the plugin

In a new terminal, from the repo root:

```sh
TRACERY_HUB_URL=http://127.0.0.1:8971 claude --plugin-dir ./plugins/claude-code
```

Observe: Claude Code starts normally (the plugin is silent by design — see
`docs/CLAUDE-CODE-PLUGIN.md` "Privacy"). Note the session id if Claude Code's
UI shows one, or you can recover it in step 3.4 below.

### 3.3 Run one prompt that uses a tool, then one that spawns a subagent

Prompt 1 (uses a tool directly):

```
Run `git status` in this repo and tell me what it says.
```

Prompt 2 (spawns a subagent):

```
Use the Agent tool to launch a general-purpose subagent that lists the files in the docs/ directory and reports back what it finds.
```

Observe: both prompts complete normally in the Claude Code session itself —
there is no visible sign the plugin is doing anything, which is correct
(see the redaction table in `docs/CLAUDE-CODE-PLUGIN.md`).

### 3.4 Confirm the flow and the child flow landed on the hub

Ask Claude Code directly (this invokes the plugin's own `activity` skill):

```
What's the activity link for this session?
```

Observe: it prints a link shaped like `http://127.0.0.1:8971/ui/flows/<session_id>`.
Take `<session_id>` from that link for the checks below. If you'd rather not
rely on the skill, find the newest flow directly:

```sh
curl -s http://127.0.0.1:8971/v1/flows | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).flows[0]))"
```

Then:

```sh
curl -s "http://127.0.0.1:8971/v1/flows/<session_id>"
```

Observe: a JSON flow object whose `ops` includes a `tool:Bash` (or similar)
op from prompt 1, `status: "success"`.

```sh
curl -s "http://127.0.0.1:8971/v1/traces/<session_id>"
```

Observe: `flows` has **two** entries — the main session flow and one child
flow (`flow: "<session_id>/agent-<agent_id>"`) from the subagent in prompt
2. If the child flow is missing, re-check that prompt 2 actually invoked the
`Agent` tool (some phrasings make Claude Code answer directly without
spawning a subagent) — rephrase and retry before calling this a bug.

The main flow's label is the `cwd` basename, plus ` · <model>` only if
Claude Code's `SessionStart` payload actually included a `model` field —
real 2.1.258 headless (`-p`) sessions do not send one, so seeing just the
bare directory name in the label is expected, not a bug (see
`docs/research/claude-code-hooks.md` "Observed on 2.1.258"; this track uses
an interactive session, which was not itself captured, so either label shape
is a PASS here).

Finally, open (or curl) the deep link itself:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8971/ui/flows/<session_id>"
```

Observe `200`. In a real browser this shows the session as a graph: a root
node for the session, a `tool:Bash` node from prompt 1, and a linked child
group for the subagent from prompt 2.

**3.4 flow + child flow + /ui/flows/<session_id>: PASS / FAIL / N/A (no claude)** ______

## Report back

Fill in every line below, including every PASS/FAIL/N/A from above. Use
free text for the two "confusing" fields even if the answer is "nothing" —
an empty field reads as skipped, not as a good result.

```
Environment: node ___  npm ___  python ___ (or "not present")  docker ___ (or "not present")  claude ___ (or "not present")

Track 1 -- npm library
  1.1 install + build:              PASS / FAIL
  1.2 npm test + test:plugin:       PASS / FAIL
  1.3 embedded example animates:    PASS / FAIL
  1.4 publish:check:                PASS / FAIL

Track 2 -- self-hosted hub
  2.1 no-env hub + /v1/info + /ui/: PASS / FAIL
  2.2 demo.mjs:                     PASS / FAIL
  2.3 Docker build/run:             PASS / FAIL
  2.4 share link, no key:           PASS / FAIL

Track 3 -- Claude Code plugin
  3.4 flow + child flow + /ui link: PASS / FAIL / N/A

Bugs found (file, command, expected vs. actual -- one per line, or "none"):
  -

Fixes applied in the real repo, if any (file -> what changed):
  -

What would confuse an average user (first thing you'd want explained better
that isn't already, even if everything above passed):
  -

Anything you could not verify and why (missing tool, no network, etc.):
  -
```
