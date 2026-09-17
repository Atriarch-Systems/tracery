// Real WS test (SPEC.md §6 "Live feed"): snapshot then events, reconnect
// from cursor gets only newer events, a stale cursor gets a truncated
// snapshot, and the heartbeat frame shape is correct. Uses the `ws` package
// against an actually-listening server (not `app.inject`, which does not
// drive a real socket upgrade).
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch/tracery-core/contract';
import { createTestServer, bearer } from './route-helpers.mjs';

const KEYS = [{ id: 'full', key: 'key-full', workspace: 'default', roles: ['ingest', 'read', 'admin'] }];

function oneEvent(overrides = {}) {
  return {
    v: ACTIVITY_CONTRACT_VERSION,
    id: 'e1',
    ts: 1000,
    flow: 'f1',
    op: 'o1',
    node: 'n1',
    type: 'start',
    name: 'x',
    root: true,
    ...overrides,
  };
}

async function ingest(app, events) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/events',
    headers: bearer('key-full'),
    payload: { v: ACTIVITY_CONTRACT_VERSION, events },
  });
  assert.ok(res.statusCode === 200 || res.statusCode === 207, `ingest failed: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body);
}

/**
 * Buffers every frame from the moment the socket is created (the server can
 * push the snapshot the instant the connection opens, faster than a
 * subsequently-attached listener could catch it) so `nextFrame` never races
 * a message that already arrived.
 */
function frameQueue(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(frame);
    else queue.push(frame);
  });
  return {
    next(timeoutMs = 5000) {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a WS frame')), timeoutMs);
        waiters.push({ resolve: (frame) => (clearTimeout(timer), resolve(frame)) });
      });
    },
  };
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

test('live: snapshot on connect, then events fan out after ingest', async (t) => {
  const created = await createTestServer({ apiKeys: KEYS });
  const address = await created.app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await created.close();
  });

  await ingest(created.app, [oneEvent({ id: 'seed-1' })]);

  const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/live?flow=f1&token=key-full`);
  const frames = frameQueue(ws);
  t.after(() => ws.close());
  await waitOpen(ws);

  const snapshot = await frames.next();
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(snapshot.events.map((e) => e.id), ['seed-1']);

  await ingest(created.app, [oneEvent({ id: 'e2', op: 'o1', type: 'end', status: 'success' })]);
  const pushed = await frames.next();
  assert.equal(pushed.type, 'events');
  assert.deepEqual(pushed.events.map((e) => e.id), ['e2']);
});

test('live: reconnecting with after=<cursor> replays only newer events', async (t) => {
  const created = await createTestServer({ apiKeys: KEYS });
  const address = await created.app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await created.close();
  });

  const r1 = await ingest(created.app, [oneEvent({ id: 'a' })]);
  await ingest(created.app, [oneEvent({ id: 'b', op: 'o1', type: 'update' })]);

  const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/live?flow=f1&after=${r1.cursor}&token=key-full`);
  const frames = frameQueue(ws);
  t.after(() => ws.close());
  await waitOpen(ws);

  const frame = await frames.next();
  assert.equal(frame.type, 'events');
  assert.deepEqual(frame.events.map((e) => e.id), ['b']);
});

test('live: a cursor older than what the store holds gets a truncated snapshot', async (t) => {
  const created = await createTestServer({ apiKeys: KEYS, retentionHours: 72 });
  const address = await created.app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await created.close();
  });

  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const r1 = await ingest(created.app, [oneEvent({ id: 'old-1', flow: 'old-flow', ts: now - 10 * dayMs })]);
  await ingest(created.app, [
    { v: ACTIVITY_CONTRACT_VERSION, id: 'old-2', ts: now - 10 * dayMs + 1, flow: 'old-flow', op: 'o1', node: 'n1', type: 'end', name: 'x', status: 'success' },
  ]);
  await ingest(created.app, [oneEvent({ id: 'new-1', flow: 'new-flow', ts: now - 10 })]);

  await created.retention.runOnce();

  const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/live?after=${r1.cursor}&token=key-full`);
  const frames = frameQueue(ws);
  t.after(() => ws.close());
  await waitOpen(ws);

  const frame = await frames.next();
  assert.equal(frame.type, 'snapshot');
  assert.equal(frame.truncated, true);
  assert.deepEqual(frame.events.map((e) => e.id), ['new-1']);
});

test('live: heartbeat frame shape', { timeout: 25_000 }, async (t) => {
  const created = await createTestServer({ apiKeys: KEYS });
  const address = await created.app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await created.close();
  });

  const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/live?flow=f1&token=key-full`);
  const frames = frameQueue(ws);
  t.after(() => ws.close());
  await waitOpen(ws);
  await frames.next(); // initial snapshot

  // Waits for the real 15s server heartbeat (SPEC.md: "heartbeat every 15s"); no shortcut is exposed.
  const frame = await frames.next(20_000);
  assert.equal(frame.type, 'heartbeat');
  assert.equal(typeof frame.cursor, 'number');
  assert.equal(Object.keys(frame).sort().join(','), 'cursor,type');
});

test('live: an unauthenticated connection is closed', async (t) => {
  const created = await createTestServer({ apiKeys: KEYS });
  const address = await created.app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await created.close();
  });

  const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/live?flow=f1`);
  const closeCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not close')), 5000);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.once('open', () => {
      // Some environments deliver 'open' before the immediate server-side close; that's fine, 'close' still follows.
    });
  });
  assert.equal(closeCode, 4401);
});
