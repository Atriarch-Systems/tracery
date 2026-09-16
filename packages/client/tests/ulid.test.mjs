import test from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '../dist/ulid.js';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test('ulid() is 26-char Crockford base32 and unique across many rapid calls', () => {
  const seen = new Set();
  const ids = [];
  for (let i = 0; i < 2000; i++) {
    const id = ulid();
    assert.match(id, CROCKFORD);
    assert.equal(seen.has(id), false, `duplicate id ${id}`);
    seen.add(id);
    ids.push(id);
  }
  // Monotonic: generated back-to-back (almost certainly within the same or
  // adjacent millisecond), so lexicographic order must never go backwards.
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i] >= ids[i - 1], `${ids[i]} should sort >= ${ids[i - 1]}`);
  }
});

test('ulid() timestamp prefix is non-decreasing and reflects wall-clock order', async () => {
  const first = ulid();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = ulid();
  assert.ok(second.slice(0, 10) >= first.slice(0, 10));
  assert.ok(second > first);
});
