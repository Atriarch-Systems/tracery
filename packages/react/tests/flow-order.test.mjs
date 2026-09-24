import test from 'node:test';
import assert from 'node:assert/strict';
import { orderFlows, latestFlowId, latestFlows } from '../dist/flow-order.js';
import { buildSampleFlows, sampleFlowIds } from '@atriarch-systems/tracery-core/fixtures';

const flows = buildSampleFlows();

test('orderFlows puts active flows first, then newest-started first', () => {
  const ordered = orderFlows(flows);
  assert.equal(ordered.length, 3);
  // None of the fixture's flows are left `running` (every op ends), so this
  // degrades to newest-started-first; research-2 (T0+2350) starts after
  // research-1 (T0+2300) which starts after the parent (T0).
  assert.deepEqual(
    ordered.map((f) => f.id),
    [sampleFlowIds.research2, sampleFlowIds.research1, sampleFlowIds.parent],
  );
});

test('a running flow is ordered ahead of completed/errored ones regardless of start time', () => {
  const withRunning = new Map(flows);
  const parent = withRunning.get(sampleFlowIds.parent);
  withRunning.set(sampleFlowIds.parent, { ...parent, status: 'running', startedAt: 0 });
  const ordered = orderFlows(withRunning);
  assert.equal(ordered[0].id, sampleFlowIds.parent);
});

test('latestFlowId returns the head of orderFlows, or undefined for an empty map', () => {
  assert.equal(latestFlowId(flows), sampleFlowIds.research2);
  assert.equal(latestFlowId(new Map()), undefined);
});

test('latestFlows caps the result to `limit`', () => {
  assert.equal(latestFlows(flows, 2).length, 2);
  assert.equal(latestFlows(flows, 50).length, 3);
});
