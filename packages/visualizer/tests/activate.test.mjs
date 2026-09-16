import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDoubleClick, emptyDoubleClickState } from '../dist/activate.js';

test('two clicks on the same node within the window activate, and reset tracking', () => {
  const first = detectDoubleClick(emptyDoubleClickState(), 'node-a', 1000);
  assert.equal(first.activated, false);
  const second = detectDoubleClick(first.next, 'node-a', 1200);
  assert.equal(second.activated, true);
  assert.deepEqual(second.next, emptyDoubleClickState());
});

test('two clicks further apart than the window (default 350ms) do not activate', () => {
  const first = detectDoubleClick(emptyDoubleClickState(), 'node-a', 1000);
  const second = detectDoubleClick(first.next, 'node-a', 1351);
  assert.equal(second.activated, false);
  // The slow second click starts a fresh tracking window rather than being dropped.
  assert.equal(second.next.lastId, 'node-a');
  assert.equal(second.next.lastTs, 1351);
});

test('a click exactly at the window boundary still activates', () => {
  const first = detectDoubleClick(emptyDoubleClickState(), 'node-a', 1000);
  const second = detectDoubleClick(first.next, 'node-a', 1350);
  assert.equal(second.activated, true);
});

test('clicking a different node resets tracking instead of activating', () => {
  const first = detectDoubleClick(emptyDoubleClickState(), 'node-a', 1000);
  const second = detectDoubleClick(first.next, 'node-b', 1100);
  assert.equal(second.activated, false);
  assert.equal(second.next.lastId, 'node-b');
  // A follow-up quick click on node-b (not node-a) now activates.
  const third = detectDoubleClick(second.next, 'node-b', 1200);
  assert.equal(third.activated, true);
});

test('a custom window can be supplied', () => {
  const first = detectDoubleClick(emptyDoubleClickState(), 'node-a', 1000, 1000);
  const second = detectDoubleClick(first.next, 'node-a', 1900, 1000);
  assert.equal(second.activated, true);
});
