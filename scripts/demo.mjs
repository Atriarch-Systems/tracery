#!/usr/bin/env node
/**
 * End-to-end demo (SPEC.md §8 acceptance 4). Drives a running hub:
 *
 *   - a parent flow "orchestrator" (TS client) with an `llm` op and a `tool`
 *     op that spawns two children from the same op via `flow.spawnLink()`:
 *     child 1 through the TS client (in-process), child 2 by shelling out to
 *     `python scripts/demo_child.py '<link JSON>'` (the Python SDK).
 *   - waits for everything to flush, then asserts against the hub:
 *       1. the trace has three flows;
 *       2. both children's resolved `trace` equals the parent flow id;
 *       3. `project(flows, { mode: 'trace', trace })` yields exactly two
 *          `spawn` edges and three groups;
 *       4. a WS live subscription opened *before* any emission received
 *          every event this run produced, with a monotonically
 *          non-decreasing cursor across every frame;
 *       5. re-POSTing the parent's first (and only) batch reports
 *          `duplicates > 0` and `accepted === 0`.
 *
 * Usage: `node scripts/demo.mjs [--key <api-key>]`, or `npm run demo`.
 * Env: ACTIVITY_HUB_URL (default http://127.0.0.1:8971), ACTIVITY_API_KEY
 * (falls back to --key, then to parsing the dev key out of
 * `docker logs activity-hub-accept`, the container SPEC.md §8 acceptance 3
 * leaves running).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { ActivityTracer, httpTransport, HubClient } from '@atriarch/activity-client';
import { ACTIVITY_CONTRACT_VERSION, buildFlows, project } from '@atriarch/activity-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const HUB_URL = process.env.ACTIVITY_HUB_URL || 'http://127.0.0.1:8971';

function devKeyFromDockerLogs() {
  try {
    // `docker logs` prints the hub's structured JSON log lines verbatim, so a
    // literal newline inside the message survives only as the two characters
    // `\` `n` (JSON-escaped), not an actual line break -- match the dev key
    // token itself rather than relying on surrounding whitespace.
    const out = execFileSync('docker', ['logs', 'activity-hub-accept'], { encoding: 'utf8' });
    const match = out.match(/dev_[0-9a-f]+/);
    return match?.[0];
  } catch {
    return undefined; // docker not available, or the container isn't running -- fine, just no fallback
  }
}

const API_KEY = process.env.ACTIVITY_API_KEY || argValue('key') || devKeyFromDockerLogs();

if (!API_KEY) {
  console.error(
    'demo: no API key. Set ACTIVITY_API_KEY, pass --key <key>, or leave the container from ' +
      'SPEC.md §8 acceptance step 3 (`docker run ... --name activity-hub-accept ...`) running so its dev key can be read from `docker logs`.',
  );
  process.exit(1);
}

console.log(`[demo] hub: ${HUB_URL}`);

// ---------------------------------------------------------------------------
// PASS/FAIL bookkeeping
// ---------------------------------------------------------------------------

const results = [];
function check(name, condition, detail) {
  const ok = Boolean(condition);
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ` -- ${detail}` : ''}`);
  return ok;
}

function summarize() {
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`[demo] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`[demo] FAILED: ${failed.map((r) => r.name).join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('[demo] ALL CHECKS PASSED');
  }
}

// ---------------------------------------------------------------------------
// a transport that remembers every raw batch it was asked to send, so we can
// re-POST the first one later (check 5) -- wraps the real httpTransport.
// ---------------------------------------------------------------------------

function recordingTransport(inner) {
  const batches = [];
  return {
    batches,
    async send(events) {
      batches.push(events);
      return inner.send(events);
    },
    flush: () => inner.flush?.(),
    close: () => inner.close?.(),
  };
}

// ---------------------------------------------------------------------------
// 1. open the WS live subscription BEFORE anything is emitted (check 4)
// ---------------------------------------------------------------------------

const hub = new HubClient({ baseUrl: HUB_URL, apiKey: API_KEY, WebSocket });

const seenEventIds = new Set();
const cursors = [];
let resolveFirstFrame;
const firstFrame = new Promise((resolve) => {
  resolveFirstFrame = resolve;
});

const disposeLive = hub.live({}, (frame) => {
  resolveFirstFrame?.();
  resolveFirstFrame = undefined;
  cursors.push(frame.cursor);
  if (frame.type !== 'heartbeat') {
    for (const event of frame.events) seenEventIds.add(event.id);
  }
});

// HubClient.live() reconnects forever on failure (e.g. a bad key), so a
// connection that never succeeds would otherwise hang this script forever --
// bound the wait and fail loudly instead.
const firstFrameOrTimeout = Promise.race([
  firstFrame.then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
]);
if (!(await firstFrameOrTimeout)) {
  disposeLive();
  console.error('[demo] WS /v1/live did not connect within 10s -- check ACTIVITY_HUB_URL / the API key.');
  process.exit(1);
}
console.log('[demo] WS /v1/live connected (pre-emission)');

// ---------------------------------------------------------------------------
// 2. emit: parent flow "orchestrator" (llm op, tool op) spawning two children
// ---------------------------------------------------------------------------

// A long flushIntervalMs means the only flush is the explicit one below, so
// the parent's entire run lands in exactly one batch -- "the first batch"
// check 5 re-sends.
const parentTransport = recordingTransport(httpTransport({ baseUrl: HUB_URL, apiKey: API_KEY }));
const parentTracer = new ActivityTracer({
  transport: parentTransport,
  actor: { id: 'agent:orchestrator', kind: 'agent' },
  flushIntervalMs: 60_000,
});

const parentFlow = parentTracer.startFlow({ label: 'demo: orchestrator' });
console.log(`[demo] parent flow: ${parentFlow.id}`);

const llmOp = parentFlow.start({ node: 'llm:main', name: 'llm.plan', kind: 'llm', context: { tokens: 42 } });
llmOp.end({ status: 'success' });

const toolOp = parentFlow.start({ node: 'tool:spawn', name: 'tool.spawn', kind: 'tool' });

// -- child 1: TypeScript client, spawnLink() from the tool op --------------
const linkForChild1 = parentFlow.spawnLink(toolOp);
const childTracer = new ActivityTracer({
  transport: httpTransport({ baseUrl: HUB_URL, apiKey: API_KEY }),
  actor: { id: 'agent:demo-child-ts', kind: 'subagent' },
});
const childFlow1 = childTracer.startFlow({ label: 'demo: ts child', link: linkForChild1 });
const child1Op = childFlow1.start({ node: 'tool:work', name: 'tool.work', kind: 'tool', context: { lang: 'ts' } });
child1Op.end();
childFlow1.end();
await childTracer.close();
console.log(`[demo] child flow 1 (ts): ${childFlow1.id}`);

// -- child 2: Python client, spawned as a subprocess ------------------------
const linkForChild2 = parentFlow.spawnLink(toolOp);
const pythonBin = process.env.PYTHON || 'python';
const child2 = spawnSync(pythonBin, [path.join(__dirname, 'demo_child.py'), JSON.stringify(linkForChild2)], {
  cwd: REPO_ROOT,
  env: { ...process.env, ACTIVITY_HUB_URL: HUB_URL, ACTIVITY_API_KEY: API_KEY },
  encoding: 'utf8',
});
if (child2.status !== 0) {
  console.error('[demo] python child failed:');
  console.error(child2.stdout);
  console.error(child2.stderr);
  process.exit(1);
}
const child2Result = JSON.parse(child2.stdout.trim().split('\n').pop());
const childFlow2Id = child2Result.flow;
console.log(`[demo] child flow 2 (python): ${childFlow2Id}`);

toolOp.end();
parentFlow.end();

// ---------------------------------------------------------------------------
// 3. flush and give the WS subscription a moment to drain in-flight frames
// ---------------------------------------------------------------------------

await parentTracer.flush();
await parentTracer.close();
await new Promise((resolve) => setTimeout(resolve, 500));

// ---------------------------------------------------------------------------
// 4. assertions via HubClient
// ---------------------------------------------------------------------------

const trace = await hub.getTrace(parentFlow.id);

check('the trace has three flows', trace.flows.length === 3, `got ${trace.flows.length}: ${trace.flows.map((f) => f.id).join(', ')}`);

const child1Summary = trace.flows.find((f) => f.id === childFlow1.id);
const child2Summary = trace.flows.find((f) => f.id === childFlow2Id);
check(
  "child 1's resolved trace equals the parent flow id",
  child1Summary?.trace === parentFlow.id,
  `got ${child1Summary?.trace}`,
);
check(
  "child 2's resolved trace equals the parent flow id",
  child2Summary?.trace === parentFlow.id,
  `got ${child2Summary?.trace}`,
);

const traceEvents = await hub.traceEvents(parentFlow.id);
const flows = buildFlows(traceEvents);
const projection = project(flows, { mode: 'trace', trace: parentFlow.id });
const spawnEdges = projection.edges.filter((edge) => edge.kind === 'spawn');
check('project(flows, { mode: "trace" }) yields exactly two spawn edges', spawnEdges.length === 2, `got ${spawnEdges.length}`);
check('project(flows, { mode: "trace" }) yields exactly three groups', projection.groups.length === 3, `got ${projection.groups.length}`);

const missingFromWs = traceEvents.filter((event) => !seenEventIds.has(event.id));
check(
  'the pre-emission WS live subscription received every event this run produced',
  missingFromWs.length === 0,
  `missing ${missingFromWs.length}/${traceEvents.length}: ${missingFromWs.map((e) => e.id).join(', ')}`,
);
const cursorsAreMonotonic = cursors.every((cursor, i) => i === 0 || cursor >= cursors[i - 1]);
check('WS frame cursors are monotonically non-decreasing', cursorsAreMonotonic, `cursors: ${JSON.stringify(cursors)}`);

disposeLive();

// Re-send the parent's first (and only, given flushIntervalMs above) batch.
const firstBatch = parentTransport.batches[0];
if (check('the parent tracer sent exactly one batch to resend', Array.isArray(firstBatch) && firstBatch.length > 0, `batches: ${parentTransport.batches.length}`)) {
  const resendRes = await fetch(`${HUB_URL}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ v: ACTIVITY_CONTRACT_VERSION, events: firstBatch }),
  });
  const resendBody = await resendRes.json();
  check(
    'resending the first batch reports duplicates > 0 and accepted 0',
    resendBody.duplicates > 0 && resendBody.accepted === 0,
    `got ${JSON.stringify(resendBody)}`,
  );
} else {
  check('resending the first batch reports duplicates > 0 and accepted 0', false, 'no batch captured to resend');
}

summarize();
