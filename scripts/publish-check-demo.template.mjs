// Copied verbatim by scripts/publish-check.mjs into a fresh temp project and
// run there as a plain Node script. Mirrors scripts/demo.mjs (SPEC.md §8
// acceptance 4) but with two TypeScript-client children instead of one TS +
// one Python child -- the Python SDK is verified separately by
// scripts/publish-check-python.mjs -- and imports only from
// '@atriarch/tracery-*' + 'ws' (never a relative path back into this repo),
// so it only proves what the installed tarballs themselves can do.
import WebSocket from 'ws';
import { ActivityTracer, httpTransport, HubClient } from '@atriarch/tracery-client';
import { buildFlows, project } from '@atriarch/tracery-core';

const HUB_URL = process.env.TRACERY_HUB_URL;
const API_KEY = process.env.TRACERY_API_KEY || '';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ` -- ${detail}` : ''}`);
  return Boolean(ok);
}

const hub = new HubClient({ baseUrl: HUB_URL, apiKey: API_KEY, WebSocket });

const seenEventIds = new Set();
let resolveFirstFrame;
const firstFrame = new Promise((resolve) => {
  resolveFirstFrame = resolve;
});
const disposeLive = hub.live({}, (frame) => {
  resolveFirstFrame?.();
  resolveFirstFrame = undefined;
  if (frame.type !== 'heartbeat') for (const event of frame.events) seenEventIds.add(event.id);
});

const firstFrameOrTimeout = Promise.race([
  firstFrame.then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
]);
if (!(await firstFrameOrTimeout)) {
  disposeLive();
  console.error('WS /v1/live did not connect within 10s');
  process.exit(1);
}

const parentTracer = new ActivityTracer({
  transport: httpTransport({ baseUrl: HUB_URL, apiKey: API_KEY }),
  actor: { id: 'agent:orchestrator', kind: 'agent' },
  flushIntervalMs: 60_000,
});
const parentFlow = parentTracer.startFlow({ label: 'publish-check: orchestrator' });
const toolOp = parentFlow.start({ node: 'tool:spawn', name: 'tool.spawn', kind: 'tool' });

const link1 = parentFlow.spawnLink(toolOp);
const child1Tracer = new ActivityTracer({
  transport: httpTransport({ baseUrl: HUB_URL, apiKey: API_KEY }),
  actor: { id: 'agent:child-1', kind: 'subagent' },
});
const childFlow1 = child1Tracer.startFlow({ label: 'publish-check: child 1', link: link1 });
childFlow1.start({ node: 'tool:work', name: 'tool.work', kind: 'tool' }).end();
childFlow1.end();
await child1Tracer.close();

const link2 = parentFlow.spawnLink(toolOp);
const child2Tracer = new ActivityTracer({
  transport: httpTransport({ baseUrl: HUB_URL, apiKey: API_KEY }),
  actor: { id: 'agent:child-2', kind: 'subagent' },
});
const childFlow2 = child2Tracer.startFlow({ label: 'publish-check: child 2', link: link2 });
childFlow2.start({ node: 'tool:work', name: 'tool.work', kind: 'tool' }).end();
childFlow2.end();
await child2Tracer.close();

toolOp.end();
parentFlow.end();
await parentTracer.flush();
await parentTracer.close();
await new Promise((resolve) => setTimeout(resolve, 500));

const trace = await hub.getTrace(parentFlow.id);
check('the trace has three flows', trace.flows.length === 3, `got ${trace.flows.length}`);

const traceEvents = await hub.traceEvents(parentFlow.id);
const flows = buildFlows(traceEvents);
const projection = project(flows, { mode: 'trace', trace: parentFlow.id });
const spawnEdges = projection.edges.filter((edge) => edge.kind === 'spawn');
check('project() yields exactly two spawn edges', spawnEdges.length === 2, `got ${spawnEdges.length}`);
check('project() yields exactly three groups', projection.groups.length === 3, `got ${projection.groups.length}`);

const missingFromWs = traceEvents.filter((event) => !seenEventIds.has(event.id));
check(
  'the pre-emission WS live subscription received every event',
  missingFromWs.length === 0,
  `missing ${missingFromWs.length}/${traceEvents.length}`,
);

disposeLive();

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((r) => r.name).join('; ')}`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
