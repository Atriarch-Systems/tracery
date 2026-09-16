import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { mapHookToEvents, createInitialState, ROOT_OP, ROOT_NODE } from '../hooks/map.mjs';
import { validateEvent } from '../../../packages/core/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

async function fixture(name) {
  const raw = await readFile(join(fixturesDir, `${name}.json`), 'utf8');
  return JSON.parse(raw);
}

function assertAllValid(events) {
  for (const event of events) {
    const result = validateEvent(event);
    assert.equal(result.ok, true, result.ok ? '' : `event ${event.id} (${event.type} on ${event.node}) invalid: ${result.reason}`);
  }
}

test('every fixture produces only valid Activity events', async () => {
  const names = [
    'session-start',
    'user-prompt-submit',
    'pre-tool-use-bash',
    'post-tool-use-bash',
    'pre-tool-use-agent',
    'subagent-start',
    'subagent-pre-tool-use',
    'subagent-post-tool-use',
    'subagent-stop',
    'post-tool-use-agent',
    'pre-tool-use-mcp',
    'post-tool-use-failure',
    'stop',
    'stop-failure',
    'pre-compact',
    'post-compact',
    'session-end',
  ];
  let state = createInitialState();
  let now = 1_700_000_000_000;
  for (const name of names) {
    const payload = await fixture(name);
    const result = mapHookToEvents(payload, state, now);
    assertAllValid(result.events);
    state = result.state;
    now += 1000;
  }
});

test('SessionStart emits a root start with the documented shape', async () => {
  const payload = await fixture('session-start');
  const { events } = mapHookToEvents(payload, createInitialState(), 1000);
  assert.equal(events.length, 1);
  const [root] = events;
  assertAllValid(events);
  assert.equal(root.flow, 'sess-main-1');
  assert.equal(root.op, ROOT_OP);
  assert.equal(root.node, ROOT_NODE);
  assert.equal(root.type, 'start');
  assert.equal(root.root, true);
  assert.equal(root.actor.id, 'agent:claude-code');
  assert.equal(root.actor.kind, 'agent');
  assert.equal(root.label, 'my-project · claude-opus-4');
  assert.equal(root.context.start_reason, 'startup');
  assert.equal(root.context.cwd, '/home/user/my-project');
  assert.equal(root.context.model, 'claude-opus-4');
  assert.equal(root.context.permission_mode, 'default');
});

test('tool start/end pairing records durationMs from the persisted start time', async () => {
  let state = createInitialState();
  const sessionStart = await fixture('session-start');
  ({ state } = mapHookToEvents(sessionStart, state, 1000));

  const pre = await fixture('pre-tool-use-bash');
  const preResult = mapHookToEvents(pre, state, 5000);
  state = preResult.state;
  assertAllValid(preResult.events);
  const startEvent = preResult.events.find((e) => e.type === 'start' && e.op === 'toolu_01BASH');
  assert.ok(startEvent, 'expected a tool start event');
  assert.equal(startEvent.node, 'tool:Bash');
  assert.equal(startEvent.kind, 'tool');
  assert.equal(startEvent.parentOp, ROOT_OP);
  assert.equal(startEvent.parentNode, ROOT_NODE);

  const post = await fixture('post-tool-use-bash');
  const postResult = mapHookToEvents(post, state, 5750);
  state = postResult.state;
  assertAllValid(postResult.events);
  const endEvent = postResult.events.find((e) => e.type === 'end' && e.op === 'toolu_01BASH');
  assert.ok(endEvent);
  assert.equal(endEvent.status, 'success');
  assert.equal(endEvent.durationMs, 750);
  assert.equal(typeof endEvent.context.output_bytes, 'number');
  assert.ok(endEvent.context.output_bytes > 0);

  // the op is no longer in flight
  assert.equal(state.tools['toolu_01BASH'], undefined);
});

test('PostToolUseFailure ends the op with status error and a bounded error message', async () => {
  let state = createInitialState();
  ({ state } = mapHookToEvents(await fixture('session-start'), state, 1000));

  const pre = {
    session_id: 'sess-main-1',
    cwd: '/home/user/my-project',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm run lint' },
    tool_use_id: 'toolu_05BASH',
  };
  ({ state } = mapHookToEvents(pre, state, 2000));

  const failure = await fixture('post-tool-use-failure');
  const { events } = mapHookToEvents(failure, state, 2300);
  assertAllValid(events);
  const endEvent = events.find((e) => e.op === 'toolu_05BASH');
  assert.equal(endEvent.status, 'error');
  assert.equal(endEvent.durationMs, 300);
  assert.equal(endEvent.context.error, "ESLint found 3 errors.");
  assert.ok(endEvent.context.error.length <= 200);
});

test('redaction: the Bash command text and prompt text never appear in emitted events', async () => {
  let state = createInitialState();
  let now = 1000;
  const allEvents = [];

  ({ state } = collect(await fixture('session-start'), state, now, allEvents));
  now += 100;
  ({ state } = collect(await fixture('user-prompt-submit'), state, now, allEvents));
  now += 100;
  ({ state } = collect(await fixture('pre-tool-use-bash'), state, now, allEvents));
  now += 100;
  ({ state } = collect(await fixture('post-tool-use-bash'), state, now, allEvents));

  assertAllValid(allEvents);
  const serialized = JSON.stringify(allEvents);

  const bashPayload = await fixture('pre-tool-use-bash');
  assert.equal(serialized.includes(bashPayload.tool_input.command), false, 'full Bash command text leaked into events');

  const promptPayload = await fixture('user-prompt-submit');
  assert.equal(serialized.includes(promptPayload.user_prompt), false, 'full prompt text leaked into events');
  assert.equal(serialized.includes('sk-secret-123'), false, 'secret-looking token from the prompt leaked into events');

  function collect(payload, s, ts, sink) {
    const result = mapHookToEvents(payload, s, ts);
    sink.push(...result.events);
    return result;
  }
});

test('UserPromptSubmit includes prompt text only when include_prompts is true', async () => {
  const payload = await fixture('user-prompt-submit');
  const state = createInitialState();

  const withoutPrompts = mapHookToEvents(payload, { ...state, config: { includePrompts: false } }, 1000);
  const annotateWithout = withoutPrompts.events.find((e) => e.type === 'annotate');
  assert.equal(annotateWithout.context.prompt, undefined);
  assert.equal(annotateWithout.context.prompt_chars, payload.user_prompt.length);

  const withPrompts = mapHookToEvents(payload, { ...state, config: { includePrompts: true } }, 1000);
  const annotateWith = withPrompts.events.find((e) => e.type === 'annotate');
  assert.equal(annotateWith.context.prompt, payload.user_prompt);
});

test('subagent child flow: single matching in-flight Agent call sets parentOp', async () => {
  let state = createInitialState();
  ({ state } = mapHookToEvents(await fixture('session-start'), state, 1000));
  ({ state } = mapHookToEvents(await fixture('pre-tool-use-agent'), state, 1100));

  const { events, state: afterStart } = mapHookToEvents(await fixture('subagent-start'), state, 1200);
  assertAllValid(events);
  const root = events.find((e) => e.root === true);
  assert.ok(root);
  assert.equal(root.flow, 'sess-main-1/agent-agent-77');
  assert.equal(root.actor.id, 'agent:claude-code/general-purpose');
  assert.equal(root.actor.kind, 'subagent');
  assert.equal(root.label, 'Research the widget API');
  assert.equal(root.link.parentFlow, 'sess-main-1');
  assert.equal(root.link.parentNode, 'tool:Agent');
  assert.equal(root.link.parentOp, 'toolu_02AGENT');
  state = afterStart;

  // subagent tool calls land on the child flow, parented at its own root op
  const { events: toolEvents, state: afterTool } = mapHookToEvents(await fixture('subagent-pre-tool-use'), state, 1300);
  assertAllValid(toolEvents);
  const toolStart = toolEvents.find((e) => e.type === 'start');
  assert.equal(toolStart.flow, 'sess-main-1/agent-agent-77');
  assert.equal(toolStart.parentOp, ROOT_OP);
  state = afterTool;

  const { events: postEvents, state: afterPost } = mapHookToEvents(await fixture('subagent-post-tool-use'), state, 1400);
  assertAllValid(postEvents);
  state = afterPost;

  const { events: stopEvents } = mapHookToEvents(await fixture('subagent-stop'), state, 1500);
  assertAllValid(stopEvents);
  const end = stopEvents.find((e) => e.type === 'end');
  assert.equal(end.flow, 'sess-main-1/agent-agent-77');
  assert.equal(end.op, ROOT_OP);
  assert.equal(end.status, 'success');
  assert.equal(end.durationMs, 300);
});

test('subagent child flow: two identical in-flight descriptions omit parentOp', async () => {
  let state = createInitialState();
  ({ state } = mapHookToEvents(await fixture('session-start'), state, 1000));

  const agentCallA = await fixture('pre-tool-use-agent');
  const agentCallB = { ...agentCallA, tool_use_id: 'toolu_02AGENT_B' };
  ({ state } = mapHookToEvents(agentCallA, state, 1100));
  ({ state } = mapHookToEvents(agentCallB, state, 1150));

  const { events } = mapHookToEvents(await fixture('subagent-start'), state, 1200);
  const root = events.find((e) => e.root === true);
  assert.equal(root.link.parentOp, undefined);
  assert.equal(root.link.parentFlow, 'sess-main-1');
});

test('a tool event from a subagent whose SubagentStart was missed still opens a child root, with no parentOp', async () => {
  let state = createInitialState();
  ({ state } = mapHookToEvents(await fixture('session-start'), state, 1000));
  ({ state } = mapHookToEvents(await fixture('pre-tool-use-agent'), state, 1100));

  // No SubagentStart fixture fed in here -- go straight to the subagent's own tool call.
  const { events } = mapHookToEvents(await fixture('subagent-pre-tool-use'), state, 1200);
  assertAllValid(events);
  const root = events.find((e) => e.root === true);
  assert.ok(root, 'expected a fallback root start for the missed SubagentStart');
  assert.equal(root.flow, 'sess-main-1/agent-agent-77');
  assert.equal(root.link.parentOp, undefined);
  const toolStart = events.find((e) => e.type === 'start' && e.op === 'toolu_03READ');
  assert.ok(toolStart);
});

test('SessionEnd clears in-memory root tracking (emit.mjs deletes the persisted state file separately)', async () => {
  let state = createInitialState();
  ({ state } = mapHookToEvents(await fixture('session-start'), state, 1000));
  const { events, state: afterEnd } = mapHookToEvents(await fixture('session-end'), state, 5000);
  assertAllValid(events);
  const end = events.find((e) => e.type === 'end');
  assert.equal(end.op, ROOT_OP);
  assert.equal(end.status, 'success');
  assert.equal(end.durationMs, 4000);
  assert.equal(end.context.end_reason, 'other');
  assert.equal(afterEnd.rootStarted, true); // map.mjs does not clear disk state; emit.mjs deletes the file
});

test('SessionEnd with end_reason "clear" maps to status cancelled', async () => {
  let state = createInitialState();
  ({ state } = mapHookToEvents(await fixture('session-start'), state, 1000));
  const { events } = mapHookToEvents({ ...(await fixture('session-end')), end_reason: 'clear' }, state, 2000);
  const end = events.find((e) => e.type === 'end');
  assert.equal(end.status, 'cancelled');
});

test('Stop annotates turn_complete and last_message_chars without leaking the message text', async () => {
  let state = createInitialState();
  ({ state } = mapHookToEvents(await fixture('session-start'), state, 1000));
  const payload = await fixture('stop');
  const { events } = mapHookToEvents(payload, state, 2000);
  assertAllValid(events);
  const annotate = events.find((e) => e.type === 'annotate');
  assert.equal(annotate.context.turn_complete, true);
  assert.equal(annotate.context.last_message_chars, payload.last_assistant_message.length);
  assert.equal(JSON.stringify(events).includes(payload.last_assistant_message), false);
});

test('StopFailure and compaction events annotate the root op', async () => {
  let state = createInitialState();
  ({ state } = mapHookToEvents(await fixture('session-start'), state, 1000));

  const stopFailure = mapHookToEvents(await fixture('stop-failure'), state, 2000);
  assertAllValid(stopFailure.events);
  assert.equal(stopFailure.events[0].context.error_type, 'overloaded');

  const preCompact = mapHookToEvents(await fixture('pre-compact'), state, 2100);
  assertAllValid(preCompact.events);
  assert.equal(preCompact.events[0].context.compact_reason, 'auto');

  const postCompact = mapHookToEvents(await fixture('post-compact'), state, 2200);
  assertAllValid(postCompact.events);
  assert.equal(postCompact.events[0].context.compact_reason, 'auto');
});

test('MCP tool names split into an mcp: node and the leaf tool as name', async () => {
  let state = createInitialState();
  ({ state } = mapHookToEvents(await fixture('session-start'), state, 1000));
  const { events } = mapHookToEvents(await fixture('pre-tool-use-mcp'), state, 1100);
  assertAllValid(events);
  const start = events.find((e) => e.type === 'start');
  assert.equal(start.node, 'mcp:openbao');
  assert.equal(start.name, 'openbao_read_secret');
  assert.equal(start.kind, 'mcp');
});

test('event ids are unique and stable within a session', async () => {
  let state = createInitialState();
  const all = [];
  const names = ['session-start', 'pre-tool-use-bash', 'post-tool-use-bash', 'stop', 'session-end'];
  let now = 1000;
  for (const name of names) {
    const result = mapHookToEvents(await fixture(name), state, now);
    all.push(...result.events);
    state = result.state;
    now += 500;
  }
  const ids = all.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'event ids must be unique');
  for (const id of ids) assert.ok(id.startsWith('sess-main-1:'));
});
