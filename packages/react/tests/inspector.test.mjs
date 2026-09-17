/**
 * Regression (ui-1): `Inspector`'s `formatTs` used to call
 * `new Date(ts).toISOString()` with no guard. `validateEvent`
 * (packages/core/src/validate.ts) only requires `ts` to be a finite number,
 * so a value outside JS's ±8.64e15 date range passes ingest and reaches
 * here, where `toISOString()` throws `RangeError: Invalid time value`
 * during render -- and with no error boundary in `apps/hub/web`, that
 * unmounts the whole hosted UI for every viewer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Inspector } from '../dist/Inspector.js';

function op(overrides) {
  return {
    id: 'op:1', node: 'llm:main', name: 'llm.plan', status: 'success',
    startedAt: undefined, endedAt: undefined, durationMs: undefined,
    parentOp: undefined, parentNode: undefined, root: true, relation: 'invoke',
    dataFrom: undefined, context: {}, timeline: [], tags: [],
    ...overrides,
  };
}

function selectionWithOp(theOp) {
  return {
    id: 'llm:main',
    label: 'llm:main',
    status: 'idle',
    data: {
      flow: 'flow:f1',
      node: { id: 'llm:main', label: 'llm:main', ops: [theOp.id], status: 'idle', running: 0, firstSeenAt: 0, lastSeenAt: 0, errorCount: 0 },
      ops: [theOp],
    },
  };
}

test('an out-of-range op.startedAt/endedAt does not throw; the raw number is shown instead', () => {
  const selection = selectionWithOp(op({ startedAt: 1e18, endedAt: -1e18 }));
  assert.doesNotThrow(() => renderToString(createElement(Inspector, { selection })));
  const markup = renderToString(createElement(Inspector, { selection }));
  assert.match(markup, /1000000000000000000/);
  assert.match(markup, /-1000000000000000000/);
});

test('an out-of-range annotate timeline entry ts does not throw', () => {
  const selection = selectionWithOp(op({
    timeline: [{ ts: 1e18, type: 'annotate', eventId: 'evt-1', context: { note: 'x' } }],
  }));
  assert.doesNotThrow(() => renderToString(createElement(Inspector, { selection })));
});

test('a normal timestamp still renders as an ISO-ish string (no regression on the happy path)', () => {
  const selection = selectionWithOp(op({ startedAt: 1_700_000_000_000 }));
  const markup = renderToString(createElement(Inspector, { selection }));
  assert.match(markup, /2023-11-14/);
});

test('an undefined ts still renders the em-dash placeholder', () => {
  const selection = selectionWithOp(op({ startedAt: undefined }));
  const markup = renderToString(createElement(Inspector, { selection }));
  assert.match(markup, /—/);
});
