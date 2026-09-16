/**
 * Pins the wire contract's version and a canonical event's exact shape.
 * A failure here means the contract changed: bump ACTIVITY_CONTRACT_VERSION
 * (SPEC.md §1) and update this test deliberately, don't just make it pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_CONTRACT_VERSION, ACTIVITY_LIMITS } from '../dist/contract.js';
import { validateEvent } from '../dist/validate.js';

test('golden: ACTIVITY_CONTRACT_VERSION is pinned to 1', () => {
  assert.equal(ACTIVITY_CONTRACT_VERSION, 1);
});

test('golden: ACTIVITY_LIMITS are pinned', () => {
  assert.deepEqual(ACTIVITY_LIMITS, {
    maxEventsPerBatch: 1000,
    maxEventBytes: 65536,
    maxIdLength: 256,
    maxTags: 32,
  });
});

test('golden: a canonical event round-trips through validateEvent with an exact JSON shape', () => {
  const raw = {
    v: 1,
    id: 'evt-golden-0001',
    ts: 1_700_000_000_000,
    seq: 1,
    flow: 'flow:golden',
    op: 'op:golden',
    node: 'llm:main',
    type: 'start',
    name: 'llm.plan',
    kind: 'llm',
    label: 'Plan the investigation',
    relation: 'invoke',
    parentOp: null,
    parentNode: null,
    root: true,
    dataFrom: 'tool:previous',
    status: 'running',
    durationMs: 0,
    actor: { id: 'agent:golden', name: 'Golden', kind: 'agent' },
    link: { parentFlow: 'flow:parent', parentOp: 'op:parent', parentNode: 'n0', trace: 'trace:golden' },
    context: { tokens: 42, ok: true, tags: ['a', 'b'], nested: { deep: null } },
    tags: ['golden', 'sample'],
  };

  const result = validateEvent(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.event, raw);
  assert.equal(
    JSON.stringify(result.event),
    '{"v":1,"id":"evt-golden-0001","ts":1700000000000,"seq":1,"flow":"flow:golden","op":"op:golden","node":"llm:main","type":"start","name":"llm.plan","kind":"llm","label":"Plan the investigation","relation":"invoke","parentOp":null,"parentNode":null,"root":true,"dataFrom":"tool:previous","status":"running","durationMs":0,"actor":{"id":"agent:golden","name":"Golden","kind":"agent"},"link":{"parentFlow":"flow:parent","parentOp":"op:parent","parentNode":"n0","trace":"trace:golden"},"context":{"tokens":42,"ok":true,"tags":["a","b"],"nested":{"deep":null}},"tags":["golden","sample"]}',
  );
});
