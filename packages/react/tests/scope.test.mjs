import test from 'node:test';
import assert from 'node:assert/strict';
import { computeScope, scopeKey, scopeModeForKey, activatedFlow, SCOPE_MODE_KEYS } from '../dist/scope.js';
import { buildSampleFlows, sampleFlowIds } from '@atriarch/tracery-core/fixtures';

const flows = buildSampleFlows();

test('scopeModeForKey maps 1/2/3 to flow/ancestors/trace and ignores other keys', () => {
  assert.equal(scopeModeForKey('1'), 'flow');
  assert.equal(scopeModeForKey('2'), 'ancestors');
  assert.equal(scopeModeForKey('3'), 'trace');
  assert.equal(scopeModeForKey('4'), undefined);
  assert.equal(scopeModeForKey('a'), undefined);
  assert.deepEqual(Object.keys(SCOPE_MODE_KEYS).sort(), ['1', '2', '3']);
});

test('computeScope: "flow" mode scopes to the active flow alone', () => {
  const scope = computeScope('flow', sampleFlowIds.research1, flows);
  assert.deepEqual(scope, { mode: 'flow', flow: sampleFlowIds.research1 });
});

test('computeScope: "ancestors" mode scopes to the active flow plus its chain', () => {
  const scope = computeScope('ancestors', sampleFlowIds.research1, flows);
  assert.deepEqual(scope, { mode: 'ancestors', flow: sampleFlowIds.research1 });
});

test('computeScope: "trace" mode resolves the active flow\'s trace id', () => {
  const scope = computeScope('trace', sampleFlowIds.research1, flows);
  assert.equal(scope.mode, 'trace');
  assert.equal(scope.trace, flows.get(sampleFlowIds.research1).trace);
  assert.equal(scope.trace, flows.get(sampleFlowIds.parent).trace); // same trace as the parent
});

test('computeScope: "trace" mode falls back to the flow id itself when the flow is unknown', () => {
  const scope = computeScope('trace', 'flow:unknown', flows);
  assert.deepEqual(scope, { mode: 'trace', trace: 'flow:unknown' });
});

test('scopeKey is stable and distinguishes mode/flow/trace', () => {
  assert.equal(scopeKey({ mode: 'flow', flow: 'a' }), scopeKey({ mode: 'flow', flow: 'a' }));
  assert.notEqual(scopeKey({ mode: 'flow', flow: 'a' }), scopeKey({ mode: 'ancestors', flow: 'a' }));
  assert.notEqual(scopeKey({ mode: 'trace', trace: 't1' }), scopeKey({ mode: 'trace', trace: 't2' }));
});

test('activatedFlow: null when the node belongs to the currently active flow', () => {
  const node = { id: 'n1', label: 'n1', data: { flow: sampleFlowIds.parent, node: {}, ops: [] } };
  assert.equal(activatedFlow(node, sampleFlowIds.parent), null);
});

test('activatedFlow: returns the child flow id when the node belongs to a different flow', () => {
  const node = { id: 'sub::llm:main', label: 'llm:main', data: { flow: sampleFlowIds.research1, node: {}, ops: [] } };
  assert.equal(activatedFlow(node, sampleFlowIds.parent), sampleFlowIds.research1);
});

test('activatedFlow: null when the node carries no data (defensive)', () => {
  const node = { id: 'n1', label: 'n1' };
  assert.equal(activatedFlow(node, sampleFlowIds.parent), null);
});
