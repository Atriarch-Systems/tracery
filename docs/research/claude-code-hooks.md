# Claude Code hooks: reference for the Activity plugin

Researched 2026-09-16 against the official docs (sources at the end). Facts the
docs state are given plainly; where the docs are silent it says "Not documented".

## Events the plugin uses

| Event | Matcher | Fires |
| --- | --- | --- |
| `SessionStart` | `startup`, `resume`, `clear`, `compact`, `fork` | session begins or resumes |
| `UserPromptSubmit` | none | user submits a prompt |
| `PreToolUse` | tool name, `\|` alternatives, or regex (`mcp__memory__.*`) | before a tool runs (can block) |
| `PostToolUse` | tool name | after a tool succeeds |
| `PostToolUseFailure` | tool name | after a tool fails |
| `SubagentStart` | agent type (`general-purpose`, `Explore`, custom name, `^plugin:agent$`) | subagent spawned |
| `SubagentStop` | agent type | subagent finished |
| `Stop` | none | Claude finishes a turn |
| `StopFailure` | error type (`rate_limit`, `overloaded`, `server_error`, `max_output_tokens`, ...) | turn ended by an API error |
| `PreCompact` / `PostCompact` | `manual`, `auto` | context compaction |
| `SessionEnd` | `clear`, `resume`, `logout`, `prompt_input_exit`, `other` | session terminates |

Other events exist (Notification, MessageDisplay, PostToolBatch, TaskCreated,
TaskCompleted, PermissionRequest, PermissionDenied, CwdChanged, FileChanged,
ConfigChange, WorktreeCreate/Remove, PreModelSwitch/PostModelSwitch, Elicitation,
InstructionsLoaded, TeammateIdle, Setup, UserPromptExpansion). Not needed for v1.

## Payload fields

Common to nearly all events: `session_id`, `transcript_path`, `cwd`,
`hook_event_name`; most turn-scoped events also carry `prompt_id` (UUID per
turn), `permission_mode`, and `effort: { level }`; `scratchpad_dir` is optional.

| Event | Extra fields |
| --- | --- |
| `SessionStart` | `start_reason`; `model` (optional canonical model name) |
| `UserPromptSubmit` | `user_prompt` (full text: never forward it) |
| `PreToolUse` | `tool_name`, `tool_input` (object), `tool_use_id`; `agent_id`, `agent_type` only when called from a subagent |
| `PostToolUse` | as PreToolUse plus `tool_output` (string or object; can be large) |
| `PostToolUseFailure` | as PreToolUse plus `error` (string) |
| `SubagentStart` | `agent_id`, `agent_type`, `agent_description` (optional) |
| `SubagentStop` | `agent_id`, `agent_type`, `last_assistant_message` |
| `Stop` | `last_assistant_message`, `stop_hook_active` |
| `StopFailure` | `error_type` |
| `PreCompact` / `PostCompact` | `compact_reason` |
| `SessionEnd` | `end_reason` |

Documented PreToolUse example:

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
  "cwd": "/home/user/my-project",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test", "description": "Run test suite", "timeout": 120000 },
  "tool_use_id": "toolu_01ABC123..."
}
```

## Subagents

- A subagent's tool calls fire `PreToolUse` / `PostToolUse` / `PostToolUseFailure`
  the same way as the main conversation, with the PARENT `session_id` plus
  `agent_id` (unique per spawned instance) and `agent_type`.
- `SubagentStart` and `SubagentStop` carry `agent_id` and `agent_type` and the
  parent `session_id`.
- Subagent transcripts live at
  `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`.
- Correlating a `SubagentStart` with the `Agent` tool call (`tool_use_id`) that
  spawned it: **not documented**. The `Agent` tool's PreToolUse payload has
  `tool_input.description` / `subagent_type`; `SubagentStart` has
  `agent_description` / `agent_type`. Matching on those plus ordering is a heuristic.
- Hooks declared in `settings.json` fire for subagent lifecycle events; hooks in
  a subagent's frontmatter run only while that subagent runs.

Mapping consequence for the plugin: child flow id = `${session_id}/agent-${agent_id}`,
`link.parentFlow = session_id`, `link.parentNode = "tool:Agent"`, `link.parentOp`
set only when the heuristic correlation finds exactly one in-flight `Agent`
tool_use whose `description` equals `agent_description`; otherwise omitted.

## Execution semantics

- Default timeout for command hooks: 600 s; `UserPromptSubmit` 30 s;
  `SessionEnd` hooks share a 1.5 s total budget, raised to the longest declared
  per-hook `timeout` up to 60 s. Set `"timeout": N` (seconds) per hook.
- Hooks matching one event run in parallel; results merge after all finish.
- Exit 0: success; stdout starting with `{` is parsed as JSON output; other
  stdout is added to Claude's context on events that support `additionalContext`.
  Exit 2: blocking error on blocking events (PreToolUse, UserPromptSubmit, Stop
  keeps Claude going, ...). Any other non-zero: non-blocking error, first line
  of stderr shown in the transcript. A telemetry hook must always exit 0 and
  print nothing to stdout.
- `PreToolUse` fires before permission checks in every permission mode.
- `EndConversation` fires no tool hooks. Hooks fire in `-p` mode.
- Env vars for command hooks: `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`
  (plugin install dir), `CLAUDE_PLUGIN_DATA` (`~/.claude/plugins/data/{plugin-id}/`,
  persistent: use it for the spool), `CLAUDE_ENV_FILE`, `CLAUDE_EFFORT`,
  `CLAUDE_CODE_REMOTE`.
- Command hooks have an `async: true` option (does not block Claude); details
  beyond that are not documented. Do not rely on it for ordering.
- `type: "http"` hooks exist: they POST the hook JSON to a URL; non-2xx is a
  non-blocking error; header interpolation only for vars listed in
  `allowedEnvVars`. Whether `${user_config.*}` interpolates into http hook
  headers is not documented.
- Payload size limits: not documented. `tool_output` can be large; truncate before forwarding.

## Plugin packaging

```
plugin/
├── .claude-plugin/plugin.json     # only this file lives here
├── hooks/hooks.json
├── hooks/emit.mjs
├── skills/activity/SKILL.md       # invoked as /plugin-name:activity
└── README.md
```

`plugin.json`: `name` (kebab-case, required), `version`, `description`, `author`,
`license`, `hooks` (path or inline), `skills`, `userConfig`.

`hooks/hooks.json` shape:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "", "hooks": [
  { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/emit.mjs\"", "timeout": 5 } ] } ] } }
```

Quote `${CLAUDE_PLUGIN_ROOT}` because install paths may contain spaces.

`userConfig` prompts the user when the plugin is enabled and stores values in
`~/.claude/settings.json` under `pluginConfigs[<plugin-id>].options`
(sensitive values encrypted):

```json
"userConfig": {
  "hub_url": { "type": "string", "title": "Activity hub URL", "required": true },
  "api_key": { "type": "string", "title": "Ingest API key", "sensitive": true, "required": true },
  "workspace": { "type": "string", "title": "Workspace", "default": "default" }
}
```

Values reach hook commands as `${user_config.hub_url}` substitution in the
command string and as `CLAUDE_PLUGIN_OPTION_HUB_URL` style environment
variables. The emitter should read the env vars first and fall back to
`ACTIVITY_HUB_URL` / `ACTIVITY_API_KEY` / `ACTIVITY_WORKSPACE` so it also works
when installed as plain settings.json hooks.

Install for development: `claude --plugin-dir ./plugins/claude-code`. From a
marketplace: `/plugin install <name>@<marketplace>`.

## Sources

- https://code.claude.com/docs/en/hooks-guide.md
- https://code.claude.com/docs/en/hooks.md
- https://code.claude.com/docs/en/plugins.md
- https://code.claude.com/docs/en/plugins-reference.md
- https://code.claude.com/docs/en/sub-agents.md
- https://code.claude.com/docs/en/settings-reference.md
