// Runs hooks/emit.mjs as a real child process (exactly how Claude Code
// invokes it: JSON on stdin, config via env vars, expected to exit 0 always)
// against a fake `node:http` hub, and asserts the spool-then-drain behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spoolPathFor } from '../hooks/emit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const emitPath = join(here, '..', 'hooks', 'emit.mjs');

async function makeDataDir() {
  return mkdtemp(join(tmpdir(), 'tracery-emit-test-'));
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

// The spool is keyed by destination (hub URL + workspace + API key; see
// plugin-3), so reading it back means computing the same path emit.mjs did.
async function spoolLines(dataDir, config) {
  try {
    const raw = await readFile(spoolPathFor(dataDir, config), 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function sessionStartPayload(sessionId) {
  return {
    session_id: sessionId,
    cwd: '/home/user/my-project',
    hook_event_name: 'SessionStart',
    start_reason: 'startup',
    model: 'claude-opus-4',
  };
}

test('no config at all: exits 0 silently and writes nothing', async () => {
  const dataDir = await makeDataDir();
  try {
    const { code, stdout, stderr } = await runEmit(sessionStartPayload('sess-noconf'), {
      CLAUDE_PLUGIN_OPTION_HUB_URL: '',
      CLAUDE_PLUGIN_OPTION_API_KEY: '',
      TRACERY_HUB_URL: '',
      TRACERY_API_KEY: '',
    }, dataDir);
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    const lines = await spoolLines(dataDir, { hubUrl: '', apiKey: '', workspace: 'default' });
    assert.equal(lines.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('hub down: spool grows, exit 0, nothing on stdout', async () => {
  const dataDir = await makeDataDir();
  try {
    const env = {
      CLAUDE_PLUGIN_OPTION_HUB_URL: 'http://127.0.0.1:1', // nothing listens here
      CLAUDE_PLUGIN_OPTION_API_KEY: 'test-key',
    };
    const spoolConfig = { hubUrl: 'http://127.0.0.1:1', apiKey: 'test-key', workspace: 'default' };
    const { code, stdout } = await runEmit(sessionStartPayload('sess-hubdown'), env, dataDir);
    assert.equal(code, 0);
    assert.equal(stdout, '');
    const lines = await spoolLines(dataDir, spoolConfig);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.flow, 'sess-hubdown');
    assert.equal(event.type, 'start');

    // a second hook call appends rather than replacing
    const { code: code2 } = await runEmit(
      { session_id: 'sess-hubdown', cwd: '/home/user/my-project', hook_event_name: 'Stop', last_assistant_message: 'done' },
      env,
      dataDir,
    );
    assert.equal(code2, 0);
    const lines2 = await spoolLines(dataDir, spoolConfig);
    assert.equal(lines2.length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('hub up: spool drains, batch shape is correct, Authorization header present', async () => {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers['authorization'],
        contentType: req.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [], cursor: 1 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const dataDir = await makeDataDir();
  try {
    const env = {
      CLAUDE_PLUGIN_OPTION_HUB_URL: `http://127.0.0.1:${port}`,
      CLAUDE_PLUGIN_OPTION_API_KEY: 'test-key',
      CLAUDE_PLUGIN_OPTION_WORKSPACE: 'default',
    };
    const { code } = await runEmit(sessionStartPayload('sess-hubup'), env, dataDir);
    assert.equal(code, 0);

    assert.equal(received.length, 1);
    const req = received[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/events');
    assert.equal(req.authorization, 'Bearer test-key');
    assert.equal(req.contentType, 'application/json');
    assert.equal(req.body.v, 1);
    assert.equal(req.body.workspace, 'default');
    assert.ok(Array.isArray(req.body.events));
    assert.equal(req.body.events.length, 1);
    assert.equal(req.body.events[0].flow, 'sess-hubup');

    const lines = await spoolLines(dataDir, { hubUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspace: 'default' });
    assert.equal(lines.length, 0, 'spool should be drained after a successful post');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Task ("local mode"): hub_url alone is valid configuration -- a local hub
// with no TRACERY_API_KEYS runs with auth off, so api_key must be optional.
test('hub up, no api_key configured: spool drains with no Authorization header at all', async () => {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers['authorization'],
        contentType: req.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [], cursor: 1 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const dataDir = await makeDataDir();
  try {
    const env = {
      CLAUDE_PLUGIN_OPTION_HUB_URL: `http://127.0.0.1:${port}`,
      CLAUDE_PLUGIN_OPTION_API_KEY: '',
      CLAUDE_PLUGIN_OPTION_WORKSPACE: 'default',
    };
    const { code, stdout, stderr } = await runEmit(sessionStartPayload('sess-nokey'), env, dataDir);
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '', 'no-api_key configuration must not warn -- it is valid, not partial');

    assert.equal(received.length, 1);
    const req = received[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/events');
    assert.equal(req.authorization, undefined, 'no Authorization header at all, not "Bearer undefined"/"Bearer "');
    assert.equal(req.contentType, 'application/json');

    const lines = await spoolLines(dataDir, { hubUrl: `http://127.0.0.1:${port}`, apiKey: '', workspace: 'default' });
    assert.equal(lines.length, 0, 'spool should be drained after a successful post');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Regression for plugin-1: two hook processes for the same session, firing
// concurrently (Claude Code runs hooks in parallel for overlapping tool
// calls), must both survive -- distinct ids, and both tool_use_ids recorded
// in the persisted state -- rather than one clobbering the other's
// bookkeeping via an unsynchronised state-file read-modify-write.
test('concurrent hook processes for the same session do not collide ids or clobber each other\'s state', async () => {
  const dataDir = await makeDataDir();
  try {
    const env = {
      CLAUDE_PLUGIN_OPTION_HUB_URL: 'http://127.0.0.1:1', // unreachable: exercise the spool + state path only
      CLAUDE_PLUGIN_OPTION_API_KEY: 'test-key',
    };
    const spoolConfig = { hubUrl: 'http://127.0.0.1:1', apiKey: 'test-key', workspace: 'default' };

    await runEmit(sessionStartPayload('sess-concurrent'), env, dataDir);

    // Two PreToolUse hooks for the same session, launched together -- this
    // is what two parallel tool calls in one turn look like on disk.
    const toolPayload = (toolUseId) => ({
      session_id: 'sess-concurrent',
      cwd: '/home/user/my-project',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_use_id: toolUseId,
    });
    const [resultA, resultB] = await Promise.all([
      runEmit(toolPayload('toolu_CONC_A'), env, dataDir),
      runEmit(toolPayload('toolu_CONC_B'), env, dataDir),
    ]);
    assert.equal(resultA.code, 0);
    assert.equal(resultB.code, 0);

    const lines = await spoolLines(dataDir, spoolConfig);
    const events = lines.map((l) => JSON.parse(l));
    const starts = events.filter((e) => e.type === 'start' && (e.op === 'toolu_CONC_A' || e.op === 'toolu_CONC_B'));
    assert.equal(starts.length, 2, 'both concurrent tool starts must reach the spool');
    const ids = events.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'no two spooled events share an id');

    const statePath = join(dataDir, 'state', 'sess-concurrent.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.ok(state.tools['toolu_CONC_A'], 'toolu_CONC_A must survive the concurrent write');
    assert.ok(state.tools['toolu_CONC_B'], 'toolu_CONC_B must survive the concurrent write');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Regression for plugin-2: draining must never lose an event appended by a
// concurrent hook process. With a real (if slightly slow) hub, two
// concurrent invocations posting through the same spool must together
// deliver every event -- the old truncate-in-place rewrite could erase an
// event appended by the other process while a POST was in flight.
test('concurrent drains never lose an event to a truncating rewrite', async () => {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      received.push(...body.events);
      // A small delay widens the window a non-atomic rewrite would race in.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: body.events.length, duplicates: 0, rejected: [], cursor: 1 }));
      }, 150);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const dataDir = await makeDataDir();
  try {
    const env = {
      CLAUDE_PLUGIN_OPTION_HUB_URL: `http://127.0.0.1:${port}`,
      CLAUDE_PLUGIN_OPTION_API_KEY: 'test-key',
    };
    const spoolConfig = { hubUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspace: 'default' };

    await runEmit(sessionStartPayload('sess-concdrain'), env, dataDir);
    const stopPayload = (n) => ({
      session_id: 'sess-concdrain',
      cwd: '/home/user/my-project',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `echo ${n}` },
      tool_use_id: `toolu_DRAIN_${n}`,
    });

    const results = await Promise.all([
      runEmit(stopPayload(1), env, dataDir),
      runEmit(stopPayload(2), env, dataDir),
    ]);
    for (const r of results) assert.equal(r.code, 0);

    const leftover = (await spoolLines(dataDir, spoolConfig)).map((l) => JSON.parse(l));
    const allEvents = [...received, ...leftover];
    const starts = allEvents.filter((e) => e.op === 'toolu_DRAIN_1' || e.op === 'toolu_DRAIN_2');
    assert.equal(starts.length, 2, `expected both tool starts to be accounted for (hub + spool), got ${starts.length}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Regression for plugin-3: a session whose hub/workspace/key differs between
// invocations (e.g. this plugin's shared per-user data dir used across
// projects) must never drain one destination's queued events into another.
test('spool is isolated per destination: draining one hub never sends another hub\'s queued events', async () => {
  const receivedB = [];
  const serverB = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      receivedB.push(...body.events);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: body.events.length, duplicates: 0, rejected: [], cursor: 1 }));
    });
  });
  await new Promise((resolve) => serverB.listen(0, '127.0.0.1', resolve));
  const portB = serverB.address().port;

  const dataDir = await makeDataDir();
  try {
    // Destination A: unreachable, so its event stays spooled.
    const envA = { CLAUDE_PLUGIN_OPTION_HUB_URL: 'http://127.0.0.1:1', CLAUDE_PLUGIN_OPTION_API_KEY: 'key-a', CLAUDE_PLUGIN_OPTION_WORKSPACE: 'workspace-a' };
    const configA = { hubUrl: 'http://127.0.0.1:1', apiKey: 'key-a', workspace: 'workspace-a' };
    await runEmit(sessionStartPayload('sess-shared'), envA, dataDir);
    const linesA = await spoolLines(dataDir, configA);
    assert.equal(linesA.length, 1, 'destination A should have one queued event');

    // Destination B: a different hub/key/workspace, same session id (the
    // plugin's data dir is shared across projects, not per-destination).
    const envB = { CLAUDE_PLUGIN_OPTION_HUB_URL: `http://127.0.0.1:${portB}`, CLAUDE_PLUGIN_OPTION_API_KEY: 'key-b', CLAUDE_PLUGIN_OPTION_WORKSPACE: 'workspace-b' };
    const configB = { hubUrl: `http://127.0.0.1:${portB}`, apiKey: 'key-b', workspace: 'workspace-b' };
    await runEmit(
      { session_id: 'sess-shared', cwd: '/home/user/my-project', hook_event_name: 'Stop', last_assistant_message: 'done' },
      envB,
      dataDir,
    );

    // Destination B's hub must only ever see destination B's own event.
    assert.equal(receivedB.length, 1);
    assert.equal(receivedB[0].flow, 'sess-shared');
    assert.equal(receivedB[0].type, 'annotate');

    // Destination A's queued event must still be sitting in its own spool,
    // untouched and undelivered to B.
    const linesAAfter = await spoolLines(dataDir, configA);
    assert.equal(linesAAfter.length, 1, 'destination A\'s event must not have been drained by destination B\'s run');
  } finally {
    await new Promise((resolve) => serverB.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Regression for plugin-11 (drainSpool half): a 207 partial-accept must
// surface as a diagnosable, single stderr line rather than disappear.
test('a 207 partial-accept from the hub is surfaced on stderr, once', async () => {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(207, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: 0, duplicates: 0, rejected: [{ index: 0, reason: 'context too large' }], cursor: 1 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const dataDir = await makeDataDir();
  try {
    const env = { CLAUDE_PLUGIN_OPTION_HUB_URL: `http://127.0.0.1:${port}`, CLAUDE_PLUGIN_OPTION_API_KEY: 'test-key' };
    const { code, stderr } = await runEmit(sessionStartPayload('sess-partial'), env, dataDir);
    assert.equal(code, 0);
    const stderrLines = stderr.split('\n').filter((l) => l.length > 0);
    assert.equal(stderrLines.length, 1, `expected exactly one stderr line, got: ${JSON.stringify(stderrLines)}`);
    assert.match(stderrLines[0], /rejected 1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Regression for plugin-13: session_id becomes a filename component;
// path-shaped input must be rejected rather than used to build a path.
test('a path-shaped session_id is rejected rather than used to build a file path', async () => {
  const dataDir = await makeDataDir();
  try {
    const env = { CLAUDE_PLUGIN_OPTION_HUB_URL: 'http://127.0.0.1:1', CLAUDE_PLUGIN_OPTION_API_KEY: 'test-key' };
    const { code, stdout, stderr } = await runEmit(
      { session_id: '../../evil', cwd: '/home/user/my-project', hook_event_name: 'SessionStart', start_reason: 'startup' },
      env,
      dataDir,
    );
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.ok(stderr.length > 0);
    // Nothing should have been written under dataDir/state at all, let alone
    // outside it.
    await assert.rejects(stat(join(dataDir, 'state', '..', '..', 'evil.json')));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Regression for plugin-14: an oversized hook payload must not be buffered
// without bound; it should be skipped (still exit 0, still write nothing).
test('an oversized hook payload on stdin is skipped rather than buffered without bound', async () => {
  const dataDir = await makeDataDir();
  try {
    const env = { CLAUDE_PLUGIN_OPTION_HUB_URL: 'http://127.0.0.1:1', CLAUDE_PLUGIN_OPTION_API_KEY: 'test-key' };
    const hugeOutput = 'x'.repeat(9 * 1024 * 1024); // over the 8 MB cap
    const payload = {
      session_id: 'sess-huge',
      cwd: '/home/user/my-project',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_HUGE',
      tool_output: hugeOutput,
    };
    const { code, stdout, stderr } = await runEmit(payload, env, dataDir);
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.ok(stderr.length > 0);
    const lines = await spoolLines(dataDir, { hubUrl: 'http://127.0.0.1:1', apiKey: 'test-key', workspace: 'default' });
    assert.equal(lines.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('SessionEnd deletes the persisted state file', async () => {
  const dataDir = await makeDataDir();
  try {
    const env = {
      CLAUDE_PLUGIN_OPTION_HUB_URL: 'http://127.0.0.1:1',
      CLAUDE_PLUGIN_OPTION_API_KEY: 'test-key',
    };
    await runEmit(sessionStartPayload('sess-end-clears'), env, dataDir);
    const statePath = join(dataDir, 'state', 'sess-end-clears.json');
    await stat(statePath); // must exist

    await runEmit(
      { session_id: 'sess-end-clears', cwd: '/home/user/my-project', hook_event_name: 'SessionEnd', end_reason: 'other' },
      env,
      dataDir,
    );
    await assert.rejects(stat(statePath));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
