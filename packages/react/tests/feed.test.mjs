import test from 'node:test';
import assert from 'node:assert/strict';
import {
  feedReducer,
  initialFeedState,
  reconnectAfter,
  shouldPoll,
  WS_FAILURES_BEFORE_POLLING,
} from '../dist/feed.js';

function snapshot(cursor, events = [], truncated = false) {
  return { type: 'snapshot', cursor, events, truncated };
}
function events(cursor, list = []) {
  return { type: 'events', cursor, events: list };
}
function heartbeat(cursor) {
  return { type: 'heartbeat', cursor };
}

test('initial state is connecting, no cursor, no failures', () => {
  const state = initialFeedState();
  assert.equal(state.status, 'connecting');
  assert.equal(state.cursor, undefined);
  assert.equal(state.wsFailures, 0);
  assert.equal(state.truncated, false);
  assert.equal(shouldPoll(state), false);
});

test('initial state can seed a resume cursor', () => {
  const state = initialFeedState(42);
  assert.equal(state.cursor, 42);
  assert.equal(reconnectAfter(state), 42);
});

test('a snapshot frame moves the feed to live, sets the cursor, resets failures', () => {
  let state = initialFeedState();
  state = feedReducer(state, { type: 'disconnect' }); // reconnecting, wsFailures 1
  state = feedReducer(state, { type: 'frame', frame: snapshot(10, [{ id: 'e1' }]) });
  assert.equal(state.status, 'live');
  assert.equal(state.cursor, 10);
  assert.equal(state.wsFailures, 0);
  assert.equal(state.truncated, false);
});

test('an events frame advances the cursor and keeps the feed live', () => {
  let state = feedReducer(initialFeedState(), { type: 'frame', frame: snapshot(1) });
  state = feedReducer(state, { type: 'frame', frame: events(5, [{ id: 'e2' }]) });
  assert.equal(state.status, 'live');
  assert.equal(state.cursor, 5);
});

test('a heartbeat frame advances the cursor without changing anything else meaningful', () => {
  let state = feedReducer(initialFeedState(), { type: 'frame', frame: snapshot(1) });
  state = feedReducer(state, { type: 'frame', frame: heartbeat(2) });
  assert.equal(state.status, 'live');
  assert.equal(state.cursor, 2);
  assert.equal(state.truncated, false);
});

test('disconnect: first failure reconnects, keeping the last cursor for resume', () => {
  let state = feedReducer(initialFeedState(), { type: 'frame', frame: snapshot(7) });
  state = feedReducer(state, { type: 'disconnect' });
  assert.equal(state.status, 'reconnecting');
  assert.equal(state.wsFailures, 1);
  assert.equal(reconnectAfter(state), 7);
  assert.equal(shouldPoll(state), false);
});

test('disconnect: fallback to polling once WS has failed twice', () => {
  let state = feedReducer(initialFeedState(), { type: 'frame', frame: snapshot(3) });
  state = feedReducer(state, { type: 'disconnect' });
  assert.equal(state.status, 'reconnecting');
  state = feedReducer(state, { type: 'disconnect' });
  assert.equal(state.wsFailures, WS_FAILURES_BEFORE_POLLING);
  assert.equal(state.status, 'polling');
  assert.equal(shouldPoll(state), true);
  // The cursor a poll (or a fresh socket) should resume from is preserved.
  assert.equal(reconnectAfter(state), 3);
});

test('a successful WS frame after reconnecting clears the failure count (recovery)', () => {
  let state = feedReducer(initialFeedState(), { type: 'frame', frame: snapshot(1) });
  state = feedReducer(state, { type: 'disconnect' });
  assert.equal(state.status, 'reconnecting');
  state = feedReducer(state, { type: 'frame', frame: events(2) });
  assert.equal(state.status, 'live');
  assert.equal(state.wsFailures, 0);
});

test('a truncated snapshot marks the feed stale; a non-truncated one clears it', () => {
  let state = feedReducer(initialFeedState(), { type: 'frame', frame: snapshot(9, [], true) });
  assert.equal(state.truncated, true);
  // A subsequent events frame does not implicitly clear truncated (only a
  // fresh snapshot speaks to whether history is contiguous).
  state = feedReducer(state, { type: 'frame', frame: events(10) });
  assert.equal(state.truncated, true);
  state = feedReducer(state, { type: 'frame', frame: snapshot(11, [], false) });
  assert.equal(state.truncated, false);
});

test('polling: poll-ok keeps status polling and advances the cursor/truncated flag', () => {
  let state = feedReducer(initialFeedState(), { type: 'disconnect' });
  state = feedReducer(state, { type: 'disconnect' }); // now polling
  assert.equal(state.status, 'polling');
  state = feedReducer(state, { type: 'poll-ok', frame: snapshot(20, [], true) });
  assert.equal(state.status, 'polling');
  assert.equal(state.cursor, 20);
  assert.equal(state.truncated, true);
});

test('polling: poll-error keeps the feed polling for the next tick to retry', () => {
  let state = feedReducer(initialFeedState(), { type: 'disconnect' });
  state = feedReducer(state, { type: 'disconnect' });
  const before = state;
  state = feedReducer(state, { type: 'poll-error' });
  assert.equal(state.status, 'polling');
  assert.equal(state.cursor, before.cursor);
});

// Regression (ui-9): the module's own header comment says "A frame applied
// while `polling` keeps the status `polling`", but the implementation used
// to unconditionally return `status: 'live'`. A message queued on a socket
// that has since been superseded by polling can still arrive after the
// switch (disposing a socket is asynchronous), which used to paint the
// connection indicator `live` while the only real transport was a poll timer.
test('a frame delivered while polling keeps the feed polling, per this module\'s documented contract', () => {
  let state = feedReducer(initialFeedState(), { type: 'disconnect' });
  state = feedReducer(state, { type: 'disconnect' }); // now polling
  assert.equal(state.status, 'polling');
  state = feedReducer(state, { type: 'frame', frame: events(30) });
  assert.equal(state.status, 'polling');
  assert.equal(state.cursor, 30);
  assert.equal(state.wsFailures, 0);
});

test('reset returns to the initial state, optionally reseeding a resume cursor', () => {
  let state = feedReducer(initialFeedState(), { type: 'frame', frame: snapshot(99) });
  state = feedReducer(state, { type: 'reset', after: 5 });
  assert.equal(state.status, 'connecting');
  assert.equal(state.cursor, 5);
  assert.equal(state.wsFailures, 0);
  assert.equal(state.truncated, false);
});
