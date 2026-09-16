/**
 * A deterministic sample trace used by this package's own tests, by other
 * workstreams' tests, and by the demo script (SPEC.md §8 acceptance 4).
 *
 * Story: agent:orchestrator plans, searches, checks a guard policy, gets human
 * approval, then spawns two research subagents from the same search op. Each
 * subagent plans, searches, writes memory (subagent:research-1's memory write
 * carries a `dataFrom` back to its own search) and reports back on `llm:main`
 * (its own node, which also self-loops as `op:p-report` on the parent --
 * useful for exercising self-edge suppression). subagent:research-2's search
 * fails, so flow:research-2 ends up `status: 'error'`. Fixed ids, fixed
 * timestamps, no randomness: safe to assert against byte-for-byte.
 */
import { ACTIVITY_CONTRACT_VERSION, type ActivityEvent } from './contract.js';
import { buildFlows, type Flow } from './flows.js';

const T0 = 1_700_000_000_000;

function evt(partial: Omit<ActivityEvent, 'v'>): ActivityEvent {
  return { v: ACTIVITY_CONTRACT_VERSION, ...partial };
}

const orchestrator = { id: 'agent:orchestrator', name: 'Orchestrator', kind: 'agent' };
const research1 = { id: 'subagent:research-1', name: 'Research Agent 1', kind: 'subagent' };
const research2 = { id: 'subagent:research-2', name: 'Research Agent 2', kind: 'subagent' };

export const sampleFlowIds = {
  parent: 'flow:parent',
  research1: 'flow:research-1',
  research2: 'flow:research-2',
} as const;

export const sampleTraceEvents: readonly ActivityEvent[] = [
  // --- parent flow: flow:parent --------------------------------------------
  evt({ id: 'evt-p-01', ts: T0, flow: sampleFlowIds.parent, op: 'op:p-plan', node: 'llm:main', type: 'start',
    name: 'llm.plan', kind: 'llm', label: 'Plan the investigation', root: true, actor: orchestrator }),
  evt({ id: 'evt-p-02', ts: T0 + 300, flow: sampleFlowIds.parent, op: 'op:p-plan', node: 'llm:main', type: 'update',
    name: 'llm.plan', context: { tokens: 128 } }),
  evt({ id: 'evt-p-03', ts: T0 + 800, flow: sampleFlowIds.parent, op: 'op:p-plan', node: 'llm:main', type: 'end',
    name: 'llm.plan', status: 'success', durationMs: 800, context: { tokens: 256 } }),

  evt({ id: 'evt-p-04', ts: T0 + 850, flow: sampleFlowIds.parent, op: 'op:p-search', node: 'tool:search', type: 'start',
    name: 'tool.search', kind: 'tool', label: 'Search prior incidents', parentOp: 'op:p-plan', parentNode: 'llm:main' }),
  evt({ id: 'evt-p-05', ts: T0 + 1000, flow: sampleFlowIds.parent, op: 'op:p-search', node: 'tool:search', type: 'annotate',
    name: 'tool.search', context: { note: 'expanding query to include closed tickets' } }),
  evt({ id: 'evt-p-06', ts: T0 + 1400, flow: sampleFlowIds.parent, op: 'op:p-search', node: 'tool:search', type: 'end',
    name: 'tool.search', status: 'success', durationMs: 550, context: { hits: 7 } }),

  evt({ id: 'evt-p-07', ts: T0 + 1450, flow: sampleFlowIds.parent, op: 'op:p-guard', node: 'guard:policy', type: 'start',
    name: 'guard.check', kind: 'guard', parentOp: 'op:p-search', parentNode: 'tool:search' }),
  evt({ id: 'evt-p-08', ts: T0 + 1600, flow: sampleFlowIds.parent, op: 'op:p-guard', node: 'guard:policy', type: 'end',
    name: 'guard.check', status: 'success' }),

  evt({ id: 'evt-p-09', ts: T0 + 1650, flow: sampleFlowIds.parent, op: 'op:p-human', node: 'human:approval', type: 'start',
    name: 'human.approve', kind: 'human', parentOp: 'op:p-guard', parentNode: 'guard:policy' }),
  evt({ id: 'evt-p-10', ts: T0 + 2000, flow: sampleFlowIds.parent, op: 'op:p-human', node: 'human:approval', type: 'end',
    name: 'human.approve', status: 'success' }),

  evt({ id: 'evt-p-11', ts: T0 + 2050, flow: sampleFlowIds.parent, op: 'op:p-spawn-r1', node: 'tool:search', type: 'start',
    name: 'flow.spawn', kind: 'tool', parentOp: 'op:p-search', parentNode: 'tool:search' }),
  evt({ id: 'evt-p-12', ts: T0 + 2100, flow: sampleFlowIds.parent, op: 'op:p-spawn-r1', node: 'tool:search', type: 'end',
    name: 'flow.spawn', status: 'success' }),

  evt({ id: 'evt-p-13', ts: T0 + 2150, flow: sampleFlowIds.parent, op: 'op:p-spawn-r2', node: 'tool:search', type: 'start',
    name: 'flow.spawn', kind: 'tool', parentOp: 'op:p-search', parentNode: 'tool:search' }),
  evt({ id: 'evt-p-14', ts: T0 + 2200, flow: sampleFlowIds.parent, op: 'op:p-spawn-r2', node: 'tool:search', type: 'end',
    name: 'flow.spawn', status: 'success' }),

  // Self-edge (parentNode === node, both llm:main): suppressed at project() time.
  evt({ id: 'evt-p-15', ts: T0 + 4300, flow: sampleFlowIds.parent, op: 'op:p-report', node: 'llm:main', type: 'start',
    name: 'llm.report', kind: 'llm', parentOp: 'op:p-plan', parentNode: 'llm:main' }),
  evt({ id: 'evt-p-16', ts: T0 + 4500, flow: sampleFlowIds.parent, op: 'op:p-report', node: 'llm:main', type: 'update',
    name: 'llm.report', context: { tokens: 96 } }),
  evt({ id: 'evt-p-17', ts: T0 + 4800, flow: sampleFlowIds.parent, op: 'op:p-report', node: 'llm:main', type: 'end',
    name: 'llm.report', status: 'success', durationMs: 500 }),

  // --- child flow: flow:research-1 -----------------------------------------
  evt({ id: 'evt-r1-01', ts: T0 + 2300, flow: sampleFlowIds.research1, op: 'op:r1-plan', node: 'llm:main', type: 'start',
    name: 'llm.plan', kind: 'llm', label: 'Plan research angle', root: true, actor: research1,
    link: { parentFlow: sampleFlowIds.parent, parentOp: 'op:p-spawn-r1', parentNode: 'tool:search' } }),
  evt({ id: 'evt-r1-02', ts: T0 + 2450, flow: sampleFlowIds.research1, op: 'op:r1-plan', node: 'llm:main', type: 'update',
    name: 'llm.plan', context: { tokens: 64 } }),
  evt({ id: 'evt-r1-03', ts: T0 + 2600, flow: sampleFlowIds.research1, op: 'op:r1-plan', node: 'llm:main', type: 'end',
    name: 'llm.plan', status: 'success', durationMs: 300 }),

  evt({ id: 'evt-r1-04', ts: T0 + 2650, flow: sampleFlowIds.research1, op: 'op:r1-search', node: 'tool:search', type: 'start',
    name: 'tool.search', kind: 'tool', parentOp: 'op:r1-plan', parentNode: 'llm:main' }),
  evt({ id: 'evt-r1-05', ts: T0 + 3000, flow: sampleFlowIds.research1, op: 'op:r1-search', node: 'tool:search', type: 'end',
    name: 'tool.search', status: 'success', durationMs: 350, context: { hits: 3 } }),

  // dataFrom: memory write consumes this flow's own search output.
  evt({ id: 'evt-r1-06', ts: T0 + 3050, flow: sampleFlowIds.research1, op: 'op:r1-memory', node: 'memory:notes', type: 'start',
    name: 'memory.write', kind: 'memory', parentOp: 'op:r1-search', parentNode: 'tool:search', dataFrom: 'tool:search' }),
  evt({ id: 'evt-r1-07', ts: T0 + 3150, flow: sampleFlowIds.research1, op: 'op:r1-memory', node: 'memory:notes', type: 'annotate',
    name: 'memory.write', context: { note: 'summarised 3 hits into 1 note' } }),
  evt({ id: 'evt-r1-08', ts: T0 + 3400, flow: sampleFlowIds.research1, op: 'op:r1-memory', node: 'memory:notes', type: 'end',
    name: 'memory.write', status: 'success', durationMs: 350 }),

  evt({ id: 'evt-r1-09', ts: T0 + 3450, flow: sampleFlowIds.research1, op: 'op:r1-report', node: 'llm:main', type: 'start',
    name: 'llm.report', kind: 'llm', parentOp: 'op:r1-memory', parentNode: 'memory:notes' }),
  evt({ id: 'evt-r1-10', ts: T0 + 3550, flow: sampleFlowIds.research1, op: 'op:r1-report', node: 'llm:main', type: 'update',
    name: 'llm.report', context: { tokens: 40 } }),
  evt({ id: 'evt-r1-11', ts: T0 + 3750, flow: sampleFlowIds.research1, op: 'op:r1-report', node: 'llm:main', type: 'end',
    name: 'llm.report', status: 'success', durationMs: 300 }),

  // --- child flow: flow:research-2 (its search fails) -----------------------
  evt({ id: 'evt-r2-01', ts: T0 + 2350, flow: sampleFlowIds.research2, op: 'op:r2-plan', node: 'llm:main', type: 'start',
    name: 'llm.plan', kind: 'llm', label: 'Plan research angle', root: true, actor: research2,
    link: { parentFlow: sampleFlowIds.parent, parentOp: 'op:p-spawn-r2', parentNode: 'tool:search' } }),
  evt({ id: 'evt-r2-02', ts: T0 + 2550, flow: sampleFlowIds.research2, op: 'op:r2-plan', node: 'llm:main', type: 'end',
    name: 'llm.plan', status: 'success', durationMs: 200 }),

  evt({ id: 'evt-r2-03', ts: T0 + 2600, flow: sampleFlowIds.research2, op: 'op:r2-search', node: 'tool:search', type: 'start',
    name: 'tool.search', kind: 'tool', parentOp: 'op:r2-plan', parentNode: 'llm:main' }),
  evt({ id: 'evt-r2-04', ts: T0 + 2900, flow: sampleFlowIds.research2, op: 'op:r2-search', node: 'tool:search', type: 'update',
    name: 'tool.search', status: 'error', context: { attempt: 1 } }),
  evt({ id: 'evt-r2-05', ts: T0 + 3050, flow: sampleFlowIds.research2, op: 'op:r2-search', node: 'tool:search', type: 'end',
    name: 'tool.search', status: 'error', durationMs: 450, context: { error: 'timeout' } }),

  evt({ id: 'evt-r2-06', ts: T0 + 3100, flow: sampleFlowIds.research2, op: 'op:r2-memory', node: 'memory:notes', type: 'start',
    name: 'memory.write', kind: 'memory', parentOp: 'op:r2-search', parentNode: 'tool:search' }),
  evt({ id: 'evt-r2-07', ts: T0 + 3250, flow: sampleFlowIds.research2, op: 'op:r2-memory', node: 'memory:notes', type: 'annotate',
    name: 'memory.write', context: { note: 'recording partial results despite search error' } }),
  evt({ id: 'evt-r2-08', ts: T0 + 3500, flow: sampleFlowIds.research2, op: 'op:r2-memory', node: 'memory:notes', type: 'end',
    name: 'memory.write', status: 'success', durationMs: 400 }),

  evt({ id: 'evt-r2-09', ts: T0 + 3550, flow: sampleFlowIds.research2, op: 'op:r2-report', node: 'llm:main', type: 'start',
    name: 'llm.report', kind: 'llm', parentOp: 'op:r2-memory', parentNode: 'memory:notes' }),
  evt({ id: 'evt-r2-10', ts: T0 + 3650, flow: sampleFlowIds.research2, op: 'op:r2-report', node: 'llm:main', type: 'update',
    name: 'llm.report', context: { tokens: 30 } }),
  evt({ id: 'evt-r2-11', ts: T0 + 3900, flow: sampleFlowIds.research2, op: 'op:r2-report', node: 'llm:main', type: 'end',
    name: 'llm.report', status: 'success', durationMs: 350 }),
];

/** Convenience: builds the sample trace's flows in one call. */
export function buildSampleFlows(): ReadonlyMap<string, Flow> {
  return buildFlows(sampleTraceEvents);
}
