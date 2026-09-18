/**
 * Regression tests for `startShareFeed`, the framework-free engine behind
 * `useShareSource` (`../src/share-feed-engine.ts`). Exercised directly (no
 * React, no DOM) with a fake `WebSocket` and a fake `fetch` -- same pattern
 * as `hub-feed-engine.test.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startShareFeed } from '../dist/share-feed-engine.js';

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}
FakeWebSocket.instances = [];

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('a snapshot share fetches once via GET .../events and never opens a socket or a poll timer', async () => {
  FakeWebSocket.instances = [];
  let fetchCount = 0;
  const frames = [];
  const engine = startShareFeed({
    baseUrl: 'http://hub.local',
    token: 'tok-1',
    live: false,
    pollIntervalMs: 20,
    WebSocket: FakeWebSocket,
    fetch: async (url) => {
      fetchCount++;
      assert.match(String(url), /\/v1\/shares\/tok-1\/events$/);
      return { ok: true, json: async () => ({ type: 'snapshot', cursor: 5, events: [], truncated: false }) };
    },
    onFrame: (frame) => frames.push(frame),
    onFeed: () => {},
    onError: () => {},
  });

  await waitFor(() => frames.length === 1);
  assert.equal(FakeWebSocket.instances.length, 0, 'a snapshot share must never open a socket');

  // Wait past a couple of poll intervals: still exactly one fetch.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fetchCount, 1, 'a snapshot share must never poll again -- it can never change');

  engine.dispose();
});

test('a live share connects to the token-scoped WS URL with no token/apiKey query param', async () => {
  FakeWebSocket.instances = [];
  const feeds = [];
  const engine = startShareFeed({
    baseUrl: 'http://hub.local',
    token: 'tok-2',
    live: true,
    pollIntervalMs: 50,
    WebSocket: FakeWebSocket,
    fetch: async () => ({ ok: true, json: async () => ({ type: 'events', cursor: 1, events: [] }) }),
    onFrame: () => {},
    onFeed: (state) => feeds.push(state),
    onError: () => {},
  });
  try {
    assert.equal(FakeWebSocket.instances.length, 1);
    const socket = FakeWebSocket.instances[0];
    assert.equal(socket.url, 'ws://hub.local/v1/shares/tok-2/live');

    socket.readyState = FakeWebSocket.OPEN;
    socket.dispatchEvent(new Event('open'));
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'snapshot', cursor: 7, events: [], truncated: false }) }));

    assert.equal(feeds[feeds.length - 1].status, 'live');
    assert.equal(feeds[feeds.length - 1].cursor, 7);
  } finally {
    engine.dispose();
  }
});

test('a live share falls back to polling GET .../events?after= after two socket failures', async () => {
  FakeWebSocket.instances = [];
  let pollCount = 0;
  const feeds = [];
  const engine = startShareFeed({
    baseUrl: 'http://hub.local',
    token: 'tok-3',
    live: true,
    pollIntervalMs: 20,
    WebSocket: FakeWebSocket,
    fetch: async (url) => {
      if (String(url).includes('/events')) pollCount++;
      return { ok: true, json: async () => ({ type: 'events', cursor: pollCount, events: [] }) };
    },
    onFrame: () => {},
    onFeed: (state) => feeds.push(state),
    onError: () => {},
  });
  try {
    for (let i = 0; i < 2; i++) {
      await waitFor(() => FakeWebSocket.instances.length === i + 1);
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      socket.dispatchEvent(new Event('close'));
    }
    await waitFor(() => feeds[feeds.length - 1]?.status === 'polling');
    await waitFor(() => pollCount >= 1);
  } finally {
    engine.dispose();
  }
});
