# tracery (Claude Code plugin)

Streams Claude Code session, tool-call and subagent activity to an
[Tracery](../../docs/SPEC.md) hub, so a running session shows up as a
live flow graph instead of only scrollback. See
[`../../docs/CLAUDE-CODE-PLUGIN.md`](../../docs/CLAUDE-CODE-PLUGIN.md) for the
full reference (mapping table, privacy details, troubleshooting). This file is
the quick start.

## Install

For development, point Claude Code straight at this directory:

```
claude --plugin-dir ./plugins/claude-code
```

From a marketplace: this repo's own [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json)
lists this plugin as `tracery`, so once its marketplace is added (assuming
the repo's intended future location):

```
/plugin marketplace add atriarch-systems/tracery
/plugin install tracery@tracery
```

See [`../../docs/CLAUDE-CODE-PLUGIN.md`](../../docs/CLAUDE-CODE-PLUGIN.md#install-and-configure)
for the local-path variant of `/plugin marketplace add`.

## Quick start: one command, no key

Point the plugin at a hub started with no configuration at all -- it runs
loopback-only with auth off (SPEC.md §6 "Auth mode"), so there is no key to
generate, copy, or configure:

```sh
npx @atriarch/tracery-hub
```

```sh
TRACERY_HUB_URL=http://127.0.0.1:8971 claude --plugin-dir ./plugins/claude-code
```

That's the whole setup. `TRACERY_HUB_URL` (or the `hub_url` userConfig
prompt) is the only thing this needs against a local hub; leave `api_key`
empty.

## Configure

Either answer the prompts Claude Code shows when the plugin is enabled
(`hub_url`, `api_key`, `workspace`, `include_prompts` -- stored in
`~/.claude/settings.json` under `pluginConfigs`), or set environment
variables, which work the same way whether or not the plugin system's
`userConfig` is in play:

| Env var | Same as userConfig | Required | Default |
| --- | --- | --- | --- |
| `TRACERY_HUB_URL` | `hub_url` | yes | `http://127.0.0.1:8971` |
| `TRACERY_API_KEY` | `api_key` | no -- only against a hub that requires keys | -- |
| `TRACERY_WORKSPACE` | `workspace` | no | `default` |
| `TRACERY_INCLUDE_PROMPTS` | `include_prompts` | no | `false` (`1`/`true`/`yes` to enable) |

With no `hub_url` at all, every hook is a silent no-op -- installing the
plugin without configuring it does nothing. `api_key` is only needed against
a hub running with `TRACERY_API_KEYS` configured (needs the `ingest` role,
see `apps/hub/README.md`); against a local-mode hub (no `TRACERY_API_KEYS`,
the `npx @atriarch/tracery-hub` default) it should be left empty.

## Sharing the plugin with someone

Three ways to hand this plugin to someone else, depending on whether this
repository is on GitHub yet.

**(a) Once this repo is on GitHub** -- the normal path, and the only one
that updates itself when the plugin changes:

```
/plugin marketplace add atriarch-systems/tracery
/plugin install tracery@tracery
```

`atriarch-systems/tracery` is the `owner/repo` GitHub location; `tracery@tracery`
is `<plugin-name>@<marketplace-name>`, both of which happen to be `tracery`
here (the plugin's own name and this repo's marketplace name, both declared
in [`../../.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json)
-- read that file's top-level `"name"` rather than assuming it always
matches the repo name). A local clone works the same way with a path instead
of `owner/repo`: `/plugin marketplace add /path/to/this/repo`.

**(b) Without GitHub at all** -- zip this directory and hand the zip over;
the recipient unzips it anywhere and points Claude Code straight at the
folder, no marketplace involved:

```sh
# you:
cd plugins && zip -r tracery-plugin.zip claude-code

# your friend, after unzipping tracery-plugin.zip somewhere:
claude --plugin-dir /path/to/unzipped/claude-code
```

This skips the marketplace manifest entirely -- `--plugin-dir` just needs a
directory containing this plugin's own `plugin.json`, `hooks/`, and
`skills/`, which is exactly what's in this folder.

**(c) Either way, your friend also needs a hub to point it at.** The plugin
only ever talks to whatever `TRACERY_HUB_URL` names -- it does not ship one.
Cheapest option once `@atriarch/tracery-hub` is published: their own local
hub, no install beyond `npx`:

```sh
npx @atriarch/tracery-hub
```

Until then (or if they'd rather run from source), a clone of this repo does
the same thing:

```sh
node apps/hub/bin/hub.mjs
```

Either way, whatever `hub_url` (or `TRACERY_HUB_URL`) they configure the
plugin with must be a URL their machine can actually reach -- `127.0.0.1`
only works if the hub runs on the same machine as their `claude` session;
across two machines they need the hub's real LAN/VPN address (and, per
`apps/hub/README.md` "Auth mode," a non-loopback hub needs `TRACERY_API_KEYS`
configured, which means an `api_key` on their end too).

## What it does

Twelve hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`,
`PreCompact`, `PostCompact`, `SessionEnd`) all run the same script,
`hooks/emit.mjs`: map the hook payload to Activity events
(`hooks/map.mjs`), append them to an on-disk spool, try to flush the spool to
the hub, always exit 0. A session becomes one flow; each subagent becomes its
own child flow linked back to the `Agent` tool call that spawned it. Full
mapping table, the correlation heuristic, and what never leaves the machine:
[`docs/CLAUDE-CODE-PLUGIN.md`](../../docs/CLAUDE-CODE-PLUGIN.md).

## The `activity` skill

Ask "what's the activity link for this session" (or run
`/tracery:activity`) to get the hub deep link for the running
session's flow.

## Troubleshooting

- **State**: `${CLAUDE_PLUGIN_DATA}/state/<session_id>.json` (falls back to
  `<tmpdir>/tracery/state/` when `CLAUDE_PLUGIN_DATA` is unset --
  true outside a real plugin install, e.g. running the hooks by hand).
- **Spool**: `${CLAUDE_PLUGIN_DATA}/spool.ndjson` (or
  `<tmpdir>/tracery/spool.ndjson`) is newline-delimited JSON
  events. Growing and not shrinking means the hub is unreachable, rejecting
  the API key, or `hub_url`/`api_key` are misconfigured; delete it to drop
  unsent history.
- Nothing arriving at the hub and no error: check `hub_url` is actually set
  (env var or userConfig) -- with it unset the emitter is a deliberate,
  silent no-op. `api_key` is optional (see "Quick start: one command, no
  key" above); leaving it empty is not a misconfiguration by itself.
- The emitter never prints anything on success and at most one line to
  stderr on a config problem; it does not surface hub-side rejections
  (see `GET /v1/flows/:id` on the hub to inspect what actually landed).

## Tests

```
node --test plugins/claude-code/tests/*.test.mjs
# or, from the repo root:
npm run test:plugin
```

`tests/map.test.mjs` is pure unit tests of the mapper against recorded hook
payload fixtures; `tests/emit.test.mjs` runs `hooks/emit.mjs` as a child
process against a fake hub; `tests/e2e.test.mjs` starts the real hub
(`apps/hub/bin/hub.mjs`) and drives a full session with a subagent through it.

## Support

☕ Tracery is free and open source. If it saves you time, [buy me a coffee](https://ko-fi.com/demonslyr).
