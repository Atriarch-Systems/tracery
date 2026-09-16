import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../dist/journal.js';
import { evt } from './helpers.mjs';

const e = (id, ts, extra = {}) => evt({ id, ts, flow: 'f1', op: `op-${id}`, node: 'n1', type: 'start', name: 'x', ...extra });

test('append returns newly added events and a duplicate count', () => {
  const j = new Journal();
  const first = j.append([e('a', 100), e('b', 200)]);
  assert.equal(first.added.length, 2);
  assert.equal(first.duplicates, 0);

  const second = j.append([e('a', 100), e('c', 300)]);
  assert.equal(second.added.length, 1);
  assert.equal(second.added[0].id, 'c');
  assert.equal(second.duplicates, 1);

  assert.equal(j.events().length, 3);
});

test('re-sending the same id within one append call is deduplicated too', () => {
  const j = new Journal();
  const result = j.append([e('a', 100), e('a', 100)]);
  assert.equal(result.added.length, 1);
  assert.equal(result.duplicates, 1);
});

test('events() is ordered by (ts, seq ?? 0, arrival)', () => {
  const j = new Journal();
  // Appended out of ts order; must come back sorted.
  j.append([e('c', 300), e('a', 100), e('b', 200)]);
  assert.deepEqual(j.events().map((ev) => ev.id), ['a', 'b', 'c']);
});

test('equal ts is broken by seq, then by arrival order', () => {
  const j = new Journal();
  j.append([e('later-seq', 100, { seq: 5 }), e('earlier-seq', 100, { seq: 1 })]);
  assert.deepEqual(j.events().map((ev) => ev.id), ['earlier-seq', 'later-seq']);

  const j2 = new Journal();
  j2.append([e('first-arrival', 100), e('second-arrival', 100)]);
  assert.deepEqual(j2.events().map((ev) => ev.id), ['first-arrival', 'second-arrival']);
});

test('a later append can still sort before earlier arrivals by ts', () => {
  const j = new Journal();
  j.append([e('b', 200)]);
  j.append([e('a', 100)]);
  assert.deepEqual(j.events().map((ev) => ev.id), ['a', 'b']);
});

test('flowIds() lists flows in order of first appearance among retained events', () => {
  const j = new Journal();
  j.append([
    evt({ id: '1', ts: 100, flow: 'f2', op: 'o1', node: 'n1', type: 'start', name: 'x' }),
    evt({ id: '2', ts: 50, flow: 'f1', op: 'o2', node: 'n1', type: 'start', name: 'x' }),
  ]);
  // Sorted by ts, so f1's event (ts:50) comes first even though appended second.
  assert.deepEqual(j.flowIds(), ['f1', 'f2']);
});

test('eventsForFlow() filters and preserves order', () => {
  const j = new Journal();
  j.append([
    evt({ id: '1', ts: 100, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'x' }),
    evt({ id: '2', ts: 200, flow: 'f2', op: 'o2', node: 'n1', type: 'start', name: 'x' }),
    evt({ id: '3', ts: 300, flow: 'f1', op: 'o3', node: 'n1', type: 'start', name: 'x' }),
  ]);
  assert.deepEqual(j.eventsForFlow('f1').map((ev) => ev.id), ['1', '3']);
});

test('partial is false until eviction, then stays true', () => {
  const j = new Journal({ maxEvents: 2 });
  assert.equal(j.partial, false);
  j.append([e('a', 100), e('b', 200)]);
  assert.equal(j.partial, false);
  j.append([e('c', 300)]);
  assert.equal(j.partial, true);
  assert.equal(j.events().length, 2);
  // Stays true even if we never evict again.
  j.append([]);
  assert.equal(j.partial, true);
});

test('eviction drops the oldest (by sort order) events first', () => {
  const j = new Journal({ maxEvents: 2 });
  j.append([e('a', 100), e('b', 200), e('c', 300)]);
  assert.deepEqual(j.events().map((ev) => ev.id), ['b', 'c']);
});

test('constructor rejects a non-positive maxEvents', () => {
  assert.throws(() => new Journal({ maxEvents: 0 }));
  assert.throws(() => new Journal({ maxEvents: -1 }));
});
