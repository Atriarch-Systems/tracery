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

const here = dirname(fileURLToPath(import.meta.url));
const emitPath = join(here, '..', 'hooks', 'emit.mjs');

async function makeDataDir() {
  return mkdtemp(join(tmpdir(), 'atriarch-activity-emit-test-'));
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

async function spoolLines(dataDir) {
  try {
    const raw = await readFile(join(dataDir, 'spool.ndjson'), 'utf8');
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
      ACTIVITY_HUB_URL: '',
      ACTIVITY_API_KEY: '',
    }, dataDir);
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    const lines = await spoolLines(dataDir);
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
    const { code, stdout } = await runEmit(sessionStartPayload('sess-hubdown'), env, dataDir);
    assert.equal(code, 0);
    assert.equal(stdout, '');
    const lines = await spoolLines(dataDir);
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
    const lines2 = await spoolLines(dataDir);
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

    const lines = await spoolLines(dataDir);
    assert.equal(lines.length, 0, 'spool should be drained after a successful post');
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
