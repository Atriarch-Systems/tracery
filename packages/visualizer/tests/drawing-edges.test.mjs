import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, emptyGraph } from '../dist/model.js';
import { drawLink } from '../dist/drawing.js';

const fakeCtx = () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_target, key) => key === 'measureText' ? value => ({ width: value.length * 6 })
      : (...args) => calls.push([key, ...args]),
    set: (_target, key, value) => { calls.push([key, value]); return true; },
  });
  return { ctx, calls };
};

const linkOf = (kind, extra = {}) => {
  const graph = reconcile(emptyGraph(), [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    [{ id: 'e', source: 'a', target: 'b', kind, ...extra }]);
  graph.links[0].source = graph.nodes[0];
  graph.links[0].target = graph.nodes[1];
  return graph.links[0];
};

test('a "data" edge draws dashed; the default "call" edge does not', () => {
  const { ctx: dataCtx, calls: dataCalls } = fakeCtx();
  drawLink(linkOf('data'), dataCtx, null, true);
  const dataDash = dataCalls.filter(c => c[0] === 'setLineDash');
  assert.ok(dataDash.some(c => Array.isArray(c[1]) && c[1].length > 0), 'expected a non-empty line dash for a data edge');

  const { ctx: callCtx, calls: callCalls } = fakeCtx();
  drawLink(linkOf('call'), callCtx, null, true);
  const callDash = callCalls.filter(c => c[0] === 'setLineDash');
  assert.ok(callDash.every(c => Array.isArray(c[1]) && c[1].length === 0), 'expected no dash for a call edge');

  const { ctx: defaultCtx, calls: defaultCalls } = fakeCtx();
  const defaultKindGraph = reconcile(emptyGraph(), [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], [{ id: 'e', source: 'a', target: 'b' }]);
  defaultKindGraph.links[0].source = defaultKindGraph.nodes[0];
  defaultKindGraph.links[0].target = defaultKindGraph.nodes[1];
  drawLink(defaultKindGraph.links[0], defaultCtx, null, true);
  const defaultDash = defaultCalls.filter(c => c[0] === 'setLineDash');
  assert.ok(defaultDash.every(c => Array.isArray(c[1]) && c[1].length === 0),
    'the default (undefined) kind behaves as call: no non-empty dash');
});

test('a "spawn" edge draws differently from a "call" edge: thicker, a hollow circle at the source end', () => {
  const { ctx: spawnCtx, calls: spawnCalls } = fakeCtx();
  drawLink(linkOf('spawn'), spawnCtx, null, true);

  const { ctx: callCtx, calls: callCalls } = fakeCtx();
  drawLink(linkOf('call'), callCtx, null, true);

  assert.notDeepEqual(spawnCalls, callCalls);

  const spawnWidths = spawnCalls.filter(c => c[0] === 'lineWidth').map(c => c[1]);
  const callWidths = callCalls.filter(c => c[0] === 'lineWidth').map(c => c[1]);
  assert.ok(Math.max(...spawnWidths) > Math.max(...callWidths), 'spawn edges must draw thicker than call edges');

  // The hollow circle at the source end: an arc call not present on a plain call edge.
  const spawnArcs = spawnCalls.filter(c => c[0] === 'arc');
  const callArcs = callCalls.filter(c => c[0] === 'arc');
  assert.ok(spawnArcs.length > callArcs.length, 'spawn edges draw an extra arc (the hollow circle) call edges do not');
});
