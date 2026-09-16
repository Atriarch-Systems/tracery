// Starts the real hub (apps/hub/bin/hub.mjs), drives emit.mjs through a full
// session with one subagent, and asserts the resulting trace: two flows, and
// the child flow's link pointing at the parent's Agent tool call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const hubBin = join(repoRoot, 'apps', 'hub', 'bin', 'hub.mjs');
const emitPath = join(here, '..', 'hooks', 'emit.mjs');

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(`${baseUrl}/healthz`);
        if (res.ok) return resolve();
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) return reject(new Error('hub did not become healthy in time'));
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

function runEmit(payload, env, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [emitPath], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

test('a session with a subagent produces two flows in the hub, linked parent to child', async (t) => {
  const port = await freePort();
  const apiKey = 'e2e-ingest-read-key';
  const hub = spawn(process.execPath, [hubBin], {
    env: {
      ...process.env,
      ACTIVITY_PORT: String(port),
      ACTIVITY_HOST: '127.0.0.1',
      ACTIVITY_STORE: 'memory',
      ACTIVITY_API_KEYS: JSON.stringify([{ id: 'e2e', key: apiKey, workspace: 'default', roles: ['ingest', 'read'] }]),
      ACTIVITY_LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let hubStderr = '';
  hub.stderr.on('data', (d) => (hubStderr += d.toString()));

  t.after(async () => {
    hub.kill('SIGTERM');
    await new Promise((resolve) => hub.once('close', resolve));
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, 10_000);

  const dataDir = await mkdtemp(join(tmpdir(), 'atriarch-activity-e2e-'));
  const env = {
    CLAUDE_PLUGIN_OPTION_HUB_URL: baseUrl,
    CLAUDE_PLUGIN_OPTION_API_KEY: apiKey,
    CLAUDE_PLUGIN_OPTION_WORKSPACE: 'default',
  };
  const sessionId = 'e2e-session-1';

  try {
    const steps = [
      { session_id: sessionId, cwd: '/home/user/my-project', hook_event_name: 'SessionStart', start_reason: 'startup', model: 'claude-opus-4' },
      {
        session_id: sessionId,
        cwd: '/home/user/my-project',
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Research the widget API', subagent_type: 'general-purpose', prompt: 'go look' },
        tool_use_id: 'toolu_agent_1',
      },
      { session_id: sessionId, cwd: '/home/user/my-project', hook_event_name: 'SubagentStart', agent_id: 'agent-e2e-1', agent_type: 'general-purpose', agent_description: 'Research the widget API' },
      {
        session_id: sessionId,
        cwd: '/home/user/my-project',
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/home/user/my-project/src/widgets/api.ts' },
        tool_use_id: 'toolu_read_1',
        agent_id: 'agent-e2e-1',
        agent_type: 'general-purpose',
      },
      {
        session_id: sessionId,
        cwd: '/home/user/my-project',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/home/user/my-project/src/widgets/api.ts' },
        tool_use_id: 'toolu_read_1',
        tool_output: 'export function listWidgets() {}',
        agent_id: 'agent-e2e-1',
        agent_type: 'general-purpose',
      },
      { session_id: sessionId, cwd: '/home/user/my-project', hook_event_name: 'SubagentStop', agent_id: 'agent-e2e-1', agent_type: 'general-purpose', last_assistant_message: 'done researching' },
      {
        session_id: sessionId,
        cwd: '/home/user/my-project',
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Research the widget API', subagent_type: 'general-purpose', prompt: 'go look' },
        tool_use_id: 'toolu_agent_1',
        tool_output: 'widgets paginate via cursor',
      },
      { session_id: sessionId, cwd: '/home/user/my-project', hook_event_name: 'Stop', last_assistant_message: 'All done.', stop_hook_active: false },
      { session_id: sessionId, cwd: '/home/user/my-project', hook_event_name: 'SessionEnd', end_reason: 'other' },
    ];

    for (const payload of steps) {
      const { code, stdout, stderr } = await runEmit(payload, env, dataDir);
      assert.equal(code, 0, `emit.mjs must always exit 0 (hook ${payload.hook_event_name}); stderr: ${stderr}`);
      assert.equal(stdout, '', `emit.mjs must print nothing to stdout (hook ${payload.hook_event_name})`);
    }

    const res = await fetch(`${baseUrl}/v1/traces/${sessionId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (res.status !== 200) {
      assert.fail(`GET /v1/traces/${sessionId} failed with ${res.status}: ${await res.text()}`);
    }
    const trace = await res.json();

    assert.equal(trace.flows.length, 2, `expected 2 flows in the trace, got ${trace.flows.length}: ${JSON.stringify(trace.flows.map((f) => f.id))}`);

    const parent = trace.flows.find((f) => f.id === sessionId);
    const child = trace.flows.find((f) => f.id === `${sessionId}/agent-agent-e2e-1`);
    assert.ok(parent, 'parent flow missing from trace');
    assert.ok(child, 'child flow missing from trace');

    assert.equal(child.link.parentFlow, sessionId);
    assert.equal(child.link.parentNode, 'tool:Agent');
    assert.equal(child.link.parentOp, 'toolu_agent_1');

    assert.equal(parent.status, 'complete');
    assert.equal(child.status, 'complete');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
