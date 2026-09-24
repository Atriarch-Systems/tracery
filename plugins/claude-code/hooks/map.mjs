// Pure mapping from a Claude Code hook payload to Tracery Graph events.
//
// No I/O, no node: imports beyond node:path (for a display label). Every event
// this produces must validate against @atriarch-systems/tracery-core's validateEvent
// (see plugins/claude-code/tests/map.test.mjs).
//
// State shape (persisted per session_id by hooks/emit.mjs):
//   {
//     counter: number,                       // per-invocation event-id suffix; see nextId()
//     rootStarted: boolean,                   // main flow's root op has been started
//     rootStartedAt: number | null,           // ts of the main root start, for durationMs
//     tools: { [tool_use_id]: { node, ts } }, // in-flight tool_use ids: node + start time
//     agentCalls: { [tool_use_id]: { description } }, // in-flight `Agent` tool calls
//     subagents: { [agent_id]: { flow, ts, rootStarted } }, // child flows seen so far
//   }
//
// Callers may additionally pass `state.config = { includePrompts }` for the
// duration of one call; it is never itself persisted (emit.mjs strips it
// before writing state back to disk) and defaults to `{ includePrompts: false }`
// when absent, so tests that omit it still get the private-by-default behaviour.

import { basename } from 'node:path';

export const ROOT_OP = 'root';
export const ROOT_NODE = 'session';

// Bounds on producer-controlled free text before it goes into an event.
// `context` is capped hub-side at 64 KB per event (ACTIVITY_LIMITS.
// maxEventBytes); these keep well under that on their own so one oversized
// prompt or agent description can never make the whole event get silently
// rejected by the hub.
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_LABEL_CHARS = 500;
const MAX_TOKEN_CHARS = 64;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Fresh per-session state, as used before any hook has fired. */
export function createInitialState() {
  return {
    counter: 0,
    rootStarted: false,
    rootStartedAt: null,
    tools: {},
    agentCalls: {},
    subagents: {},
  };
}

function cloneState(state) {
  const s = state ?? {};
  return {
    counter: typeof s.counter === 'number' ? s.counter : 0,
    rootStarted: Boolean(s.rootStarted),
    rootStartedAt: typeof s.rootStartedAt === 'number' ? s.rootStartedAt : null,
    tools: { ...(s.tools ?? {}) },
    agentCalls: { ...(s.agentCalls ?? {}) },
    subagents: { ...(s.subagents ?? {}) },
    ...(s.config !== undefined ? { config: s.config } : {}),
  };
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function byteLength(str) {
  return Buffer.byteLength(typeof str === 'string' ? str : '', 'utf8');
}

function stringifyOutput(output) {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output ?? '');
  } catch {
    return '';
  }
}

/**
 * Claude Code 2.1.258 sends the tool's result on PostToolUse as
 * `tool_response`, not the documented `tool_output` -- the latter is kept as
 * a fallback in case an older/different build still sends it. See "Observed
 * on 2.1.258" in docs/research/claude-code-hooks.md.
 */
function resolveToolResponse(p) {
  return p.tool_response !== undefined ? p.tool_response : p.tool_output;
}

/**
 * For a Bash-shaped response ({ stdout, stderr, ... }), byte-count only the
 * actual output text rather than the whole JSON envelope (interrupted,
 * isImage, noOutputExpected, ...); everything else falls back to
 * stringifyOutput's generic JSON stringification.
 */
function stringifyToolOutput(output) {
  if (
    output &&
    typeof output === 'object' &&
    !Array.isArray(output) &&
    (typeof output.stdout === 'string' || typeof output.stderr === 'string')
  ) {
    return `${output.stdout ?? ''}${output.stderr ?? ''}`;
  }
  return stringifyOutput(output);
}

function firstLineTruncated(text, max) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  const line = s.split(/\r?\n/, 1)[0] ?? '';
  return line.length > max ? line.slice(0, max) : line;
}

function clampChars(text, max) {
  return typeof text === 'string' && text.length > max ? text.slice(0, max) : text;
}

/** Truncate `text` to fit `maxBytes` of UTF-8, respecting multi-byte characters. */
function truncateToBytes(text, maxBytes) {
  const s = typeof text === 'string' ? text : '';
  if (byteLength(s) <= maxBytes) return { text: s, truncated: false };
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return { text: s.slice(0, lo), truncated: true };
}

/** node/name/kind for a tool call, per PLAN §H's redaction/mapping rules. */
export function classifyTool(toolName) {
  const name = typeof toolName === 'string' ? toolName : 'unknown';
  if (name === 'Agent') return { node: 'tool:Agent', name: 'Agent', kind: 'agent' };
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const server = parts[1] || 'unknown';
    const tool = parts.slice(2).join('__') || name;
    return { node: `mcp:${server}`, name: tool, kind: 'mcp' };
  }
  return { node: `tool:${name}`, name, kind: 'tool' };
}

/** A redacted, bounded summary of tool_input. Never the full command/prompt/file contents. */
export function redactToolInput(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const token = firstMeaningfulToken(command);
    return compact({ command_token: token || undefined, command_length: command.length });
  }
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'Glob' || toolName === 'Grep') {
    return compact({
      file_path: typeof input.file_path === 'string' ? input.file_path : undefined,
      pattern: typeof input.pattern === 'string' ? input.pattern : undefined,
    });
  }
  if (toolName === 'Agent') {
    return compact({
      description: typeof input.description === 'string' ? clampChars(input.description, MAX_LABEL_CHARS) : undefined,
      subagent_type: typeof input.subagent_type === 'string' ? clampChars(input.subagent_type, MAX_LABEL_CHARS) : undefined,
    });
  }
  const keys = Object.keys(input);
  return { input_keys: keys, input_bytes: byteLength(JSON.stringify(input)) };
}

/**
 * The first token of a Bash command, safe to forward: leading `VAR=value`
 * environment assignments (a common way secrets end up on a command line,
 * e.g. `GITHUB_TOKEN=ghp_xxx gh pr list`) are skipped rather than emitted,
 * a path-like token is reduced to its basename, and the result is bounded.
 */
function firstMeaningfulToken(command) {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && i < 2 && ENV_ASSIGNMENT_RE.test(tokens[i])) i += 1;
  const token = tokens[i] ?? '';
  const base = basename(token) || token;
  return base.length > MAX_TOKEN_CHARS ? base.slice(0, MAX_TOKEN_CHARS) : base;
}

function flowFor(payload, sessionId) {
  return payload.agent_id ? `${sessionId}/agent-${payload.agent_id}` : sessionId;
}

/**
 * Claude Code 2.1.258's SessionStart payload in headless (`-p`) sessions
 * carries only `cwd` (and `source`) -- no `model`. Label from the cwd
 * basename alone in that case; append the model only when the payload
 * actually has one (observed: present is not documented as guaranteed).
 */
function mainRootLabel(payload) {
  const rawCwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : '.';
  const base = basename(rawCwd) || rawCwd;
  return typeof payload.model === 'string' && payload.model.length > 0 ? `${base} · ${payload.model}` : base;
}

/**
 * Map one hook payload to zero or more Activity events, given the persisted
 * per-session state and the current time. Never mutates `payload` or `state`.
 */
export function mapHookToEvents(payload, state, now) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const sessionId = typeof p.session_id === 'string' ? p.session_id : '';
  const next = cloneState(state);
  const events = [];

  const nextId = () => {
    next.counter += 1;
    // Uniqueness cannot rest on the persisted counter alone: Claude Code runs
    // hooks in parallel, so two independent emit.mjs processes can load the
    // same stale counter (or both start from 0 after any state loss) and mint
    // the same id for two different events, which the hub's dedup then
    // silently collapses into one. process.pid + the event's own timestamp
    // make the id unique across concurrent processes without requiring any
    // cross-process coordination; `counter` still disambiguates multiple
    // events minted within a single invocation.
    return `${sessionId}:${process.pid}:${now}:${next.counter}`;
  };

  const mkEvent = (fields) => ({ v: 1, id: nextId(), ts: now, ...fields });

  const startMainRoot = () => {
    events.push(
      mkEvent({
        flow: sessionId,
        op: ROOT_OP,
        node: ROOT_NODE,
        type: 'start',
        name: 'session',
        kind: 'agent',
        root: true,
        label: mainRootLabel(p),
        actor: { id: 'agent:claude-code', kind: 'agent' },
        // Real payloads (2.1.258) name this field `source`, not the
        // documented `start_reason`; the emitted context key stays
        // `start_reason` for schema stability, `source` wins when both are
        // present. `model`/`permission_mode` are commonly absent entirely in
        // headless (`-p`) sessions -- compact() drops them rather than
        // sending `null`.
        context: compact({
          start_reason: p.source ?? p.start_reason,
          cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
          model: p.model,
          permission_mode: p.permission_mode,
        }),
      }),
    );
    next.rootStarted = true;
    next.rootStartedAt = now;
  };

  const ensureMainRoot = () => {
    if (!next.rootStarted) startMainRoot();
  };

  const correlateAgentCall = (description, allowSingleInFlightFallback) => {
    if (description != null) {
      const matches = Object.entries(next.agentCalls).filter(([, v]) => v && v.description === description);
      return matches.length === 1 ? matches[0][0] : undefined;
    }
    if (!allowSingleInFlightFallback) return undefined;
    // Claude Code 2.1.258's SubagentStart payload does not carry
    // agent_description at all (documented, but not observed live) -- with
    // nothing to match on, fall back to "exactly one Agent call in flight" so
    // the common single-subagent case still gets a parentOp instead of
    // silently losing the link every time. Only used for a real SubagentStart
    // (see the call site below); the missed-SubagentStart fallback in
    // ensureChildRoot deliberately does not opt into this -- it has even
    // less certainty that the in-flight call is the right one.
    const inFlight = Object.entries(next.agentCalls);
    return inFlight.length === 1 ? inFlight[0][0] : undefined;
  };

  const startChildRoot = (agentId, agentType, description, options) => {
    const flow = `${sessionId}/agent-${agentId}`;
    // Correlate on the raw, unclamped description so a long description still
    // matches its in-flight Agent tool call; only the emitted label/context
    // need bounding.
    const parentOp = correlateAgentCall(description, Boolean(options?.allowSingleInFlightFallback));
    const boundedDescription = clampChars(description, MAX_LABEL_CHARS);
    events.push(
      mkEvent({
        flow,
        op: ROOT_OP,
        node: ROOT_NODE,
        type: 'start',
        name: 'session',
        kind: 'subagent',
        root: true,
        label: boundedDescription ?? agentType ?? 'subagent',
        actor: { id: `agent:claude-code/${agentType ?? 'unknown'}`, kind: 'subagent' },
        link: compact({ parentFlow: sessionId, parentNode: 'tool:Agent', parentOp }),
        context: compact({ agent_type: agentType, agent_description: boundedDescription }),
      }),
    );
    next.subagents[agentId] = { flow, ts: now, rootStarted: true };
  };

  const ensureChildRoot = (agentId, agentType) => {
    if (!next.subagents[agentId]?.rootStarted) {
      // SubagentStart was missed: fall back to a tool-event-triggered root.
      // agent_description is not available on tool payloads, so correlation
      // cannot use it here and parentOp is always omitted in this path.
      startChildRoot(agentId, agentType, undefined);
    }
  };

  switch (p.hook_event_name) {
    case 'SessionStart': {
      startMainRoot();
      break;
    }

    case 'UserPromptSubmit': {
      ensureMainRoot();
      const includePrompts = Boolean(next.config?.includePrompts);
      // Real payloads (2.1.258) name this field `prompt`, not the documented
      // `user_prompt`; the latter is kept as a fallback.
      const text = typeof p.prompt === 'string' ? p.prompt : typeof p.user_prompt === 'string' ? p.user_prompt : '';
      const bounded = includePrompts ? truncateToBytes(text, MAX_PROMPT_BYTES) : undefined;
      events.push(
        mkEvent({
          flow: sessionId,
          op: ROOT_OP,
          node: ROOT_NODE,
          type: 'annotate',
          name: 'session',
          context: compact({
            prompt_chars: text.length,
            prompt: bounded?.text,
            prompt_truncated: bounded?.truncated ? true : undefined,
          }),
        }),
      );
      break;
    }

    case 'PreToolUse': {
      const flow = flowFor(p, sessionId);
      if (p.agent_id) ensureChildRoot(String(p.agent_id), p.agent_type);
      else ensureMainRoot();

      const cls = classifyTool(p.tool_name);
      const toolUseId = String(p.tool_use_id ?? nextId());
      events.push(
        mkEvent({
          flow,
          op: toolUseId,
          node: cls.node,
          type: 'start',
          name: cls.name,
          kind: cls.kind,
          label: cls.name,
          parentOp: ROOT_OP,
          parentNode: ROOT_NODE,
          context: redactToolInput(p.tool_name, p.tool_input),
        }),
      );
      next.tools[toolUseId] = { node: cls.node, ts: now };
      if (p.tool_name === 'Agent') {
        const description = p.tool_input && typeof p.tool_input.description === 'string' ? p.tool_input.description : undefined;
        next.agentCalls[toolUseId] = { description };
      }
      break;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const flow = flowFor(p, sessionId);
      const toolUseId = String(p.tool_use_id ?? '');
      const started = next.tools[toolUseId];
      const cls = classifyTool(p.tool_name);
      // Prefer our own persisted start time; fall back to the payload's own
      // `duration_ms` (present on real PostToolUse/PostToolUseFailure
      // payloads) when the start was never recorded, e.g. state was lost.
      const durationMs = started
        ? Math.max(0, now - started.ts)
        : typeof p.duration_ms === 'number'
          ? p.duration_ms
          : undefined;
      const failure = p.hook_event_name === 'PostToolUseFailure';
      events.push(
        mkEvent({
          flow,
          op: toolUseId,
          node: started?.node ?? cls.node,
          type: 'end',
          name: cls.name,
          status: failure ? 'error' : 'success',
          durationMs,
          context: failure
            ? { error: firstLineTruncated(p.error, 200) }
            : compact({ output_bytes: byteLength(stringifyToolOutput(resolveToolResponse(p))) }),
        }),
      );
      delete next.tools[toolUseId];
      if (p.tool_name === 'Agent') delete next.agentCalls[toolUseId];
      break;
    }

    case 'SubagentStart': {
      const agentId = String(p.agent_id ?? '');
      const description = typeof p.agent_description === 'string' ? p.agent_description : undefined;
      if (!next.subagents[agentId]?.rootStarted) {
        startChildRoot(agentId, p.agent_type, description, { allowSingleInFlightFallback: true });
      }
      break;
    }

    case 'SubagentStop': {
      const agentId = String(p.agent_id ?? '');
      const record = next.subagents[agentId];
      const flow = record?.flow ?? `${sessionId}/agent-${agentId}`;
      const durationMs = record ? Math.max(0, now - record.ts) : undefined;
      const lastMessage = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
      events.push(
        mkEvent({
          flow,
          op: ROOT_OP,
          node: ROOT_NODE,
          type: 'end',
          name: 'session',
          status: 'success',
          durationMs,
          context: compact({ last_message_chars: lastMessage.length }),
        }),
      );
      delete next.subagents[agentId];
      break;
    }

    case 'Stop': {
      ensureMainRoot();
      const lastMessage = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
      events.push(
        mkEvent({
          flow: sessionId,
          op: ROOT_OP,
          node: ROOT_NODE,
          type: 'annotate',
          name: 'session',
          context: compact({ turn_complete: true, last_message_chars: lastMessage.length }),
        }),
      );
      break;
    }

    case 'StopFailure': {
      ensureMainRoot();
      events.push(
        mkEvent({
          flow: sessionId,
          op: ROOT_OP,
          node: ROOT_NODE,
          type: 'annotate',
          name: 'session',
          context: compact({ error_type: p.error_type }),
        }),
      );
      break;
    }

    case 'PreCompact':
    case 'PostCompact': {
      ensureMainRoot();
      events.push(
        mkEvent({
          flow: sessionId,
          op: ROOT_OP,
          node: ROOT_NODE,
          type: 'annotate',
          name: 'session',
          context: compact({ compact_reason: p.compact_reason }),
        }),
      );
      break;
    }

    case 'SessionEnd': {
      ensureMainRoot();
      // Real payloads (2.1.258) name this field `reason`, not the documented
      // `end_reason`; the emitted context key stays `end_reason` for schema
      // stability, `reason` wins when both are present.
      const endReason = p.reason ?? p.end_reason;
      const status = endReason === 'clear' ? 'cancelled' : 'success';
      const durationMs = next.rootStartedAt != null ? Math.max(0, now - next.rootStartedAt) : undefined;
      events.push(
        mkEvent({
          flow: sessionId,
          op: ROOT_OP,
          node: ROOT_NODE,
          type: 'end',
          name: 'session',
          status,
          durationMs,
          context: compact({ end_reason: endReason }),
        }),
      );
      break;
    }

    default:
      break;
  }

  return { events, state: next };
}
