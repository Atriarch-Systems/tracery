import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, validateBatch } from '../dist/validate.js';
import { ACTIVITY_LIMITS } from '../dist/contract.js';
import { evt } from './helpers.mjs';

const minimal = () => evt({ id: 'e1', ts: 1000, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'llm.plan' });

test('accepts a minimal valid event', () => {
  const result = validateEvent(minimal());
  assert.equal(result.ok, true);
  assert.deepEqual(result.event, minimal());
});

test('strips unknown fields from the returned event', () => {
  const result = validateEvent({ ...minimal(), somethingElse: 'nope', extra: 123 });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.event).sort(), ['flow', 'id', 'name', 'node', 'op', 'ts', 'type', 'v']);
});

test('accepts a fully populated event', () => {
  const full = evt({
    id: 'e2', ts: 2000, seq: 5, flow: 'f1', op: 'o2', node: 'n2', type: 'end',
    name: 'tool.search', kind: 'tool', label: 'Search', relation: 'invoke',
    parentOp: 'o1', parentNode: 'n1', root: false, dataFrom: 'n0',
    status: 'success', durationMs: 120, actor: { id: 'agent:a', name: 'A', kind: 'agent' },
    link: { parentFlow: 'f0', parentOp: 'po', parentNode: 'pn', trace: 't0' },
    context: { hits: 3, nested: { ok: true, list: [1, 2, 'x', null] } }, tags: ['a', 'b'],
  });
  const result = validateEvent(full);
  assert.equal(result.ok, true);
  assert.deepEqual(result.event, full);
});

test('accepts null parentOp and parentNode', () => {
  const result = validateEvent(evt({ ...minimal(), parentOp: null, parentNode: null }));
  assert.equal(result.ok, true);
  assert.equal(result.event.parentOp, null);
  assert.equal(result.event.parentNode, null);
});

const reject = (overrides, reason) => {
  const raw = { ...minimal(), ...overrides };
  const result = validateEvent(raw);
  assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(overrides)}`);
  assert.equal(result.reason, reason);
};

test('reject: not an object', () => {
  assert.deepEqual(validateEvent(null), { ok: false, reason: 'event must be an object' });
  assert.deepEqual(validateEvent('nope'), { ok: false, reason: 'event must be an object' });
  assert.deepEqual(validateEvent([1, 2]), { ok: false, reason: 'event must be an object' });
});

test('reject: wrong contract version', () => reject({ v: 2 }, 'event.v must equal 1'));
test('reject: missing id', () => reject({ id: undefined }, 'event.id must be a non-empty string'));
test('reject: empty id', () => reject({ id: '' }, 'event.id must be a non-empty string'));
test('reject: id too long', () => reject({ id: 'x'.repeat(ACTIVITY_LIMITS.maxIdLength + 1) }, `event.id exceeds maxIdLength (${ACTIVITY_LIMITS.maxIdLength})`));
test('reject: missing ts', () => reject({ ts: undefined }, 'event.ts must be a finite number'));
test('reject: non-finite ts', () => reject({ ts: Number.POSITIVE_INFINITY }, 'event.ts must be a finite number'));
test('reject: non-finite seq', () => reject({ seq: NaN }, 'event.seq must be a finite number'));
test('reject: missing flow', () => reject({ flow: '' }, 'event.flow must be a non-empty string'));
test('reject: missing op', () => reject({ op: '' }, 'event.op must be a non-empty string'));
test('reject: missing node', () => reject({ node: '' }, 'event.node must be a non-empty string'));
test('reject: bad type', () => reject({ type: 'delete' }, 'event.type must be one of start, update, end, annotate'));
test('reject: missing name', () => reject({ name: '' }, 'event.name must be a non-empty string'));
test('reject: non-string kind', () => reject({ kind: 5 }, 'event.kind must be a string'));
test('reject: non-string label', () => reject({ label: 5 }, 'event.label must be a string'));
test('reject: non-string relation', () => reject({ relation: 5 }, 'event.relation must be a string'));
test('reject: parentOp wrong type', () => reject({ parentOp: 5 }, 'event.parentOp must be a string or null'));
test('reject: parentNode wrong type', () => reject({ parentNode: 5 }, 'event.parentNode must be a string or null'));
test('reject: root not boolean', () => reject({ root: 'yes' }, 'event.root must be a boolean'));
test('reject: empty dataFrom', () => reject({ dataFrom: '' }, 'event.dataFrom must be a non-empty string'));
test('reject: bad status', () => reject({ status: 'ok' }, 'event.status must be one of running, success, error, cancelled, skipped'));
test('reject: negative durationMs', () => reject({ durationMs: -1 }, 'event.durationMs must be a non-negative finite number'));
test('reject: non-finite durationMs', () => reject({ durationMs: Infinity }, 'event.durationMs must be a non-negative finite number'));
test('reject: actor not an object', () => reject({ actor: 'agent:a' }, 'event.actor must be an object'));
test('reject: actor missing id', () => reject({ actor: { name: 'A' } }, 'event.actor.id must be a non-empty string'));
test('reject: link not an object', () => reject({ link: 'parent' }, 'event.link must be an object'));
test('reject: link missing parentFlow', () => reject({ link: { parentOp: 'x' } }, 'event.link.parentFlow must be a non-empty string'));
test('reject: context not an object', () => reject({ context: 'nope' }, 'event.context must be a JSON-serialisable object'));
test('reject: context with a function value', () => reject({ context: { fn: () => 1 } }, 'event.context must be a JSON-serialisable object'));
test('reject: context array at top level', () => reject({ context: [1, 2] }, 'event.context must be a JSON-serialisable object'));
test('reject: tags not an array', () => reject({ tags: 'a,b' }, 'event.tags must be an array of strings'));
test('reject: tags with a non-string', () => reject({ tags: ['a', 5] }, 'event.tags must be an array of strings'));
test('reject: too many tags', () => reject({ tags: Array.from({ length: ACTIVITY_LIMITS.maxTags + 1 }, (_, i) => `t${i}`) }, `event.tags exceeds maxTags (${ACTIVITY_LIMITS.maxTags})`));

test('reject: event exceeds maxEventBytes', () => {
  const raw = { ...minimal(), context: { blob: 'x'.repeat(ACTIVITY_LIMITS.maxEventBytes) } };
  const result = validateEvent(raw);
  assert.equal(result.ok, false);
  assert.equal(result.reason, `event exceeds maxEventBytes (${ACTIVITY_LIMITS.maxEventBytes})`);
});

// ---------------------------------------------------------------------------
// validateBatch
// ---------------------------------------------------------------------------

test('validateBatch accepts a well-formed batch', () => {
  const result = validateBatch({ v: 1, workspace: 'default', events: [minimal(), evt({ id: 'e2', ts: 1001, flow: 'f1', op: 'o1', node: 'n1', type: 'end', name: 'llm.plan', status: 'success' })] });
  assert.equal(result.ok, true);
  assert.equal(result.batch.events.length, 2);
  assert.equal(result.batch.workspace, 'default');
});

test('validateBatch works without a workspace', () => {
  const result = validateBatch({ v: 1, events: [minimal()] });
  assert.equal(result.ok, true);
  assert.equal(result.batch.workspace, undefined);
});

test('validateBatch rejects a non-object', () => {
  assert.deepEqual(validateBatch(42), { ok: false, reason: 'batch must be an object' });
});

test('validateBatch rejects wrong version', () => {
  assert.deepEqual(validateBatch({ v: 2, events: [] }), { ok: false, reason: 'batch.v must equal 1' });
});

test('validateBatch rejects a non-array events field', () => {
  assert.deepEqual(validateBatch({ v: 1, events: {} }), { ok: false, reason: 'batch.events must be an array' });
});

test('validateBatch rejects batches over maxEventsPerBatch', () => {
  const events = Array.from({ length: ACTIVITY_LIMITS.maxEventsPerBatch + 1 }, (_, i) => evt({ id: `e${i}`, ts: i, flow: 'f1', op: `o${i}`, node: 'n1', type: 'start', name: 'x' }));
  const result = validateBatch({ v: 1, events });
  assert.equal(result.ok, false);
  assert.equal(result.reason, `batch.events exceeds maxEventsPerBatch (${ACTIVITY_LIMITS.maxEventsPerBatch})`);
});

test('validateBatch surfaces the index of the first invalid event', () => {
  const result = validateBatch({ v: 1, events: [minimal(), { ...minimal(), id: '' }] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'event at index 1: event.id must be a non-empty string');
});
