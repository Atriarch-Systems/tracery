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

From a marketplace: `/plugin install tracery@<marketplace>`.

## Configure

Either answer the prompts Claude Code shows when the plugin is enabled
(`hub_url`, `api_key`, `workspace`, `include_prompts` -- stored in
`~/.claude/settings.json` under `pluginConfigs`), or set environment
variables, which work the same way whether or not the plugin system's
`userConfig` is in play:

| Env var | Same as userConfig | Required | Default |
| --- | --- | --- | --- |
| `TRACERY_HUB_URL` | `hub_url` | yes | -- |
| `TRACERY_API_KEY` | `api_key` | yes | -- |
| `TRACERY_WORKSPACE` | `workspace` | no | `default` |
| `TRACERY_INCLUDE_PROMPTS` | `include_prompts` | no | `false` (`1`/`true`/`yes` to enable) |

With neither `hub_url` nor `api_key` set, every hook is a silent no-op --
installing the plugin without configuring it does nothing. `api_key` needs
the hub's `ingest` role (see `apps/hub/README.md`).

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
- Nothing arriving at the hub and no error: check both `hub_url` and
  `api_key` are actually set (env var or userConfig) -- with neither set the
  emitter is a deliberate, silent no-op.
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
