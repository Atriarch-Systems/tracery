/**
 * Regression tests for `startHubFeed`, the framework-free engine behind
 * `useHubSource` (`../src/hub-feed-engine.ts`). Exercised directly (no React,
 * no DOM) with a fake `WebSocket` and a fake `fetch`.
 *
 * ui-5: a single abrupt socket failure fires both `error` and `close` on the
 * WHATWG "fail the WebSocket connection" algorithm; counting both used to
 * double-count one failure as two, skipping the `reconnecting` state and
 * cancelling `HubClient.live`'s own backoff reconnect before its first retry.
 *
 * ui-4: an unscoped source (no single `flow` or `trace`, the hosted UI's
 * default landing route) has no SPEC.md §6 endpoint to poll once the socket
 * is gone; the old fallback silently did nothing every tick forever while
 * claiming status `polling`. It must go `offline` instead, and never start a
 * dead timer or fetch anything.
 *
 * ui-10: a poll failure's error must clear once a later poll succeeds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHubFeed } from '../dist/hub-feed-engine.js';

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

test('ui-5: error immediately followed by close on one socket counts as exactly one disconnect', () => {
  FakeWebSocket.instances = [];
  const feeds = [];
  const engine = startHubFeed({
    baseUrl: 'http://hub.local',
    apiKey: 'test-key',
    flow: 'f1',
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
    // The WHATWG close algorithm dispatches 'error' then 'close' for one abrupt failure.
    socket.dispatchEvent(new Event('error'));
    socket.dispatchEvent(new Event('close'));

    const last = feeds[feeds.length - 1];
    assert.equal(last.wsFailures, 1, 'error+close on the same socket must be counted once, not twice');
    assert.equal(last.status, 'reconnecting', 'one failure must not skip straight to polling');
  } finally {
    engine.dispose();
  }
});

test('ui-5: two genuinely separate socket failures do reach polling (the threshold still works)', async () => {
  FakeWebSocket.instances = [];
  const feeds = [];
  const engine = startHubFeed({
    baseUrl: 'http://hub.local',
    apiKey: 'test-key',
    flow: 'f1',
    pollIntervalMs: 50,
    WebSocket: FakeWebSocket,
    fetch: async () => ({ ok: true, json: async () => ({ type: 'events', cursor: 1, events: [] }) }),
    onFrame: () => {},
    onFeed: (state) => feeds.push(state),
    onError: () => {},
  });
  try {
    await waitFor(() => FakeWebSocket.instances.length >= 1);
    FakeWebSocket.instances[0].dispatchEvent(new Event('close'));
    assert.equal(feeds[feeds.length - 1].status, 'reconnecting');

    // HubClient.live schedules a reconnect on 'close' with its own backoff; wait for the next socket.
    await waitFor(() => FakeWebSocket.instances.length >= 2);
    FakeWebSocket.instances[1].dispatchEvent(new Event('close'));
    assert.equal(feeds[feeds.length - 1].status, 'polling');
    assert.equal(feeds[feeds.length - 1].wsFailures, 2);
  } finally {
    engine.dispose();
  }
});

test('ui-4: with no flow or trace and no WebSocket available, the feed goes offline instead of polling nothing forever', () => {
  const feeds = [];
  let fetchCalls = 0;
  const engine = startHubFeed({
    baseUrl: 'http://hub.local',
    apiKey: 'test-key',
    // no `flow`, no `trace`: the hosted UI's unscoped default route.
    pollIntervalMs: 10,
    WebSocket: {}, // not a function: simulates no WebSocket implementation available
    fetch: async () => {
      fetchCalls++;
      return { ok: true, json: async () => ({ type: 'events', cursor: 1, events: [] }) };
    },
    onFrame: () => {},
    onFeed: (state) => feeds.push(state),
    onError: () => {},
  });
  try {
    assert.equal(feeds[feeds.length - 1].status, 'offline');
  } finally {
    engine.dispose();
  }
  assert.equal(fetchCalls, 0, 'nothing should ever be fetched when there is no flow or trace to poll against');
});

test('ui-4: an unscoped source that falls back after two WS failures goes offline, not polling', async () => {
  FakeWebSocket.instances = [];
  const feeds = [];
  let fetchCalls = 0;
  const engine = startHubFeed({
    baseUrl: 'http://hub.local',
    apiKey: 'test-key',
    // no `flow`, no `trace`.
    pollIntervalMs: 10,
    WebSocket: FakeWebSocket,
    fetch: async () => {
      fetchCalls++;
      return { ok: true, json: async () => ({ type: 'events', cursor: 1, events: [] }) };
    },
    onFrame: () => {},
    onFeed: (state) => feeds.push(state),
    onError: () => {},
  });
  try {
    await waitFor(() => FakeWebSocket.instances.length >= 1);
    FakeWebSocket.instances[0].dispatchEvent(new Event('close'));
    await waitFor(() => FakeWebSocket.instances.length >= 2);
    FakeWebSocket.instances[1].dispatchEvent(new Event('close'));

    const last = feeds[feeds.length - 1];
    assert.equal(last.status, 'offline', 'must not claim `polling` when there is nothing to poll');

    // Give a would-be poll timer a couple of intervals to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fetchCalls, 0);
  } finally {
    engine.dispose();
  }
});

test('ui-10: an error from a failed poll clears once a later poll succeeds', async () => {
  let call = 0;
  const errors = [];
  const engine = startHubFeed({
    baseUrl: 'http://hub.local',
    apiKey: 'test-key',
    flow: 'f1',
    pollIntervalMs: 15,
    WebSocket: {}, // straight to polling, no socket involved
    fetch: async () => {
      call++;
      if (call === 1) return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) };
      return { ok: true, json: async () => ({ type: 'events', cursor: call, events: [] }) };
    },
    onFrame: () => {},
    onFeed: () => {},
    onError: (message) => errors.push(message),
  });
  try {
    await waitFor(() => errors.length >= 1);
    assert.notEqual(errors[0], undefined, 'the first (failing) poll must report an error');
    await waitFor(() => errors[errors.length - 1] === undefined);
  } finally {
    engine.dispose();
  }
});
