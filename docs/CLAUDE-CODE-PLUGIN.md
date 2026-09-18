# Claude Code plugin

`plugins/claude-code` turns a running Claude Code session into a Tracery by
Atriarch Systems flow: session start/end, every tool call, and every subagent
as its own linked child flow. It is a thin, zero-dependency adapter from [Claude
Code's hooks](https://code.claude.com/docs/en/hooks.md) to the [wire
contract](SPEC.md#1-contract) -- see
[`docs/research/claude-code-hooks.md`](research/claude-code-hooks.md) for the
hook payload reference this plugin was built against.

See [`plugins/claude-code/README.md`](../plugins/claude-code/README.md) for
install and quick configuration. This document is the full reference: the
event mapping, the privacy contract, the subagent correlation heuristic and
its limits, and troubleshooting.

## Install and configure

For development, point Claude Code straight at the plugin directory:

```
claude --plugin-dir ./plugins/claude-code
```

Or add this repository as a plugin marketplace and install from it. The
repo root's [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)
lists this plugin with `source: "./plugins/claude-code"`, so a marketplace
install resolves to the same directory as the `--plugin-dir` path above --
there's no separate build or publish step. Assuming this repo lives at
`atriarch-systems/tracery` on GitHub (the intended future location -- swap
in wherever this checkout actually lives if that's not yet true):

```
/plugin marketplace add atriarch-systems/tracery
/plugin install tracery@tracery
```

A local clone can be added as a marketplace the same way, with a path
instead of a `owner/repo` shorthand: `/plugin marketplace add
/path/to/this/repo`.

Either install path needs only `hub_url` (`userConfig` prompt, or
`TRACERY_HUB_URL`) against a hub running in local mode -- one started with
`npx @atriarch/tracery-hub` and no `TRACERY_API_KEYS` runs loopback-only with
auth off, so there is no key to configure at all:

```sh
npx @atriarch/tracery-hub
TRACERY_HUB_URL=http://127.0.0.1:8971 claude --plugin-dir ./plugins/claude-code
```

`api_key` (`TRACERY_API_KEY`) is only needed against a hub that requires
keys (`TRACERY_API_KEYS`/`_FILE` configured -- needs the `ingest` role). With
`hub_url` unset entirely, every hook is a silent no-op. See the README for
the full env var table.

## Architecture

One script, `hooks/emit.mjs`, is registered for twelve hook events in
`hooks/hooks.json`, each with a 5s timeout. On every invocation it:

1. Reads the hook JSON payload from stdin.
2. Loads this session's small persisted state from
   `${CLAUDE_PLUGIN_DATA}/state/<session_id>.json` (in-flight tool calls and
   their start times, in-flight `Agent` tool calls and their descriptions,
   which subagent ids already have a child flow).
3. Calls the pure mapper `hooks/map.mjs` (`mapHookToEvents(payload, state,
   now)`) to get zero or more Activity events plus updated state.
4. Appends the events to `${CLAUDE_PLUGIN_DATA}/spool.ndjson`.
5. Tries to drain the whole spool to `POST ${hub_url}/v1/events` in batches
   of up to 1000, with a 2s timeout per batch. A successful batch (any 2xx,
   `207` partial-accept included) is removed from the spool; a failure
   leaves it -- and everything queued after it -- for the next hook call.
6. Writes state back to disk, or deletes it on `SessionEnd`.
7. Always exits 0. Never writes to stdout. At most one line to stderr, and
   only for a configuration problem (partial config, unparseable payload).

`map.mjs` has no I/O and imports nothing but `node:path`; `emit.mjs` imports
only `node:*` builtins plus `map.mjs`. Neither imports from `packages/*` at
runtime -- only the plugin's own tests do, to validate emitted events against
`@atriarch/tracery-core`.

## Event mapping

One flow per session (`flow = session_id`); one child flow per subagent
(`flow = "${session_id}/agent-${agent_id}"`). Every flow's root operation is
`op: "root"`, `node: "session"`.

| Hook | Activity event(s) |
| --- | --- |
| `SessionStart` | root `start`. `actor: { id: "agent:claude-code", kind: "agent" }`, `label: "<cwd basename> · <model>"`, `context: { start_reason, cwd, model, permission_mode }`. |
| `UserPromptSubmit` | `annotate` on the root op: `context: { prompt_chars }`, plus `prompt: <text>` only when `include_prompts` is true. |
| `PreToolUse` | op `start`, `op: tool_use_id`, `node: "tool:<tool_name>"` (`"mcp:<server>"` for `mcp__<server>__<tool>`, with `name` set to the leaf tool), `kind: "tool"` (`"agent"` for the `Agent` tool, `"mcp"` for MCP tools), `parentOp`/`parentNode` = the flow's root. `context` is a redacted summary -- see below. |
| `PostToolUse` | op `end`, `status: "success"`, `durationMs` from the persisted start time, `context: { output_bytes }`. |
| `PostToolUseFailure` | op `end`, `status: "error"`, `context: { error }` (first line of the error, truncated to 200 chars). |
| `SubagentStart` | child flow's root `start`. `actor: { id: "agent:claude-code/<agent_type>", kind: "subagent" }`, `label: agent_description ?? agent_type`, `link: { parentFlow: session_id, parentNode: "tool:Agent", parentOp? }` -- see correlation below. |
| `SubagentStop` | child flow's root op `end`, `status: "success"`, `durationMs`, `context: { last_message_chars }`. |
| `Stop` | `annotate` on the main root: `context: { turn_complete: true, last_message_chars }`. |
| `StopFailure` | `annotate` on the main root: `context: { error_type }`. |
| `PreCompact` / `PostCompact` | `annotate` on the main root: `context: { compact_reason }`. |
| `SessionEnd` | main root op `end`, `status: "success"` (`"cancelled"` when `end_reason` is `"clear"`), `durationMs`, `context: { end_reason }`; the persisted state file is deleted. |

If a subagent's tool call arrives before its `SubagentStart` was ever seen
(a missed hook, or hooks arriving out of order), the child flow's root
`start` is synthesized from that tool event instead, with `agent_type` as the
label and `link.parentOp` always omitted (no `agent_description` is available
on a tool payload to correlate with).

### Redacted `tool_input` summaries

Never the full command, prompt, or file contents -- only what is needed to
recognise the call:

| Tool | `context` |
| --- | --- |
| `Bash` | `{ command_token, command_length }` -- first whitespace-delimited token of the command, and the command's length. Never the command text. |
| `Read`, `Write`, `Edit`, `Glob`, `Grep` | `{ file_path? , pattern? }` -- whichever the tool's input carries. Never file contents. |
| `Agent` | `{ description?, subagent_type? }` -- the task description Claude itself wrote for the subagent, not a prompt in the "never forward it" sense; needed for the correlation heuristic below. |
| anything else (including MCP tools) | `{ input_keys, input_bytes }` -- the input object's own key names and total serialized byte size, never its values. |

## Privacy: what is sent, what never is

| Sent | Never sent |
| --- | --- |
| session id, cwd, model, permission mode | full user prompt text (unless `include_prompts` is explicitly enabled) |
| tool name, redacted input summary (above) | full Bash command text |
| tool output byte count | tool output content |
| error's first line, truncated to 200 chars | full error / stack trace |
| last-assistant-message character count | last assistant message text |
| subagent type and its task description | subagent transcript content |

`include_prompts` (default `false`) is the one switch that changes this: on,
`UserPromptSubmit` additionally sends the prompt's full text. Everything else
in this table is fixed regardless of configuration.

## Subagent correlation heuristic and its limits

Claude Code does not document a way to correlate a `SubagentStart` event with
the specific `Agent` tool call (`tool_use_id`) that spawned it (see
[`docs/research/claude-code-hooks.md`](research/claude-code-hooks.md)
"Subagents"). The plugin's heuristic: track every in-flight `Agent` tool call
keyed by its `tool_input.description`; when a `SubagentStart` arrives with a
matching `agent_description`, set `link.parentOp` to that call's
`tool_use_id` only if **exactly one** in-flight call has that description.

- One matching in-flight `Agent` call -> `link.parentOp` set, so the hub can
  draw the spawn edge from the exact tool call.
- Zero matches (no description, or nothing in flight with it) -> omitted.
- Two or more in-flight `Agent` calls sharing the same description (e.g. two
  identical-looking parallel subagent dispatches) -> omitted, deliberately,
  rather than guessing which one it was.

The child flow itself is never ambiguous -- `flow =
"${session_id}/agent-${agent_id}"` always identifies the right subagent. Only
`link.parentOp` (which parent tool call node the spawn edge is drawn from) is
subject to this heuristic; when it is omitted, the hub still draws the child
flow linked to the parent flow via `link.parentFlow`, just without pinning it
to one specific `tool:Agent` call among several.

## Troubleshooting

See [`plugins/claude-code/README.md`](../plugins/claude-code/README.md#troubleshooting)
for spool/state file locations and the no-op-by-default behaviour when
unconfigured.
