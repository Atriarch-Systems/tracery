// hub-5: cursor/limit query params must fail loudly on garbage input instead
// of silently returning an empty page forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InvalidQueryError, parseCursor, parseLimit } from '../dist/routes/query.js';

test('parseCursor: absent or empty is undefined; a non-negative integer parses through', () => {
  assert.equal(parseCursor(undefined, 'after'), undefined);
  assert.equal(parseCursor('', 'after'), undefined);
  assert.equal(parseCursor('0', 'after'), 0);
  assert.equal(parseCursor('42', 'after'), 42);
});

test('parseCursor: garbage, negative, non-integer or unsafe values throw InvalidQueryError naming the field', () => {
  for (const bad of ['abc', '-1', '1.5', 'NaN', String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => parseCursor(bad, 'after'), InvalidQueryError, `expected "${bad}" to throw`);
    assert.throws(() => parseCursor(bad, 'after'), /after/);
  }
});

test('parseLimit: absent or empty falls back; a valid integer in range parses through', () => {
  assert.equal(parseLimit(undefined, 50, 1000), 50);
  assert.equal(parseLimit('', 50, 1000), 50);
  assert.equal(parseLimit('1', 50, 1000), 1);
  assert.equal(parseLimit('1000', 50, 1000), 1000);
});

test('parseLimit: zero, negative, non-integer or over-max values throw', () => {
  for (const bad of ['0', '-3', '1.5', '1001', 'abc']) {
    assert.throws(() => parseLimit(bad, 50, 1000), InvalidQueryError, `expected "${bad}" to throw`);
  }
});
