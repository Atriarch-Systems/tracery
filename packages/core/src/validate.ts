/**
 * Structural validation for the wire contract (SPEC.md §1). Rejects with a
 * precise, stable reason string rather than throwing, so producers and the hub
 * can report exactly what was wrong with a batch.
 *
 * Validation intentionally does not enforce "status required on end" as a hard
 * rejection: SPEC.md's op lifecycle table defaults a missing `end` status to
 * `success` (see flows.ts), so it is optional here too, matching the contract
 * type (`status?: ActivityStatus`).
 */
import {
  ACTIVITY_CONTRACT_VERSION,
  ACTIVITY_LIMITS,
  type ActivityActor,
  type ActivityBatch,
  type ActivityContext,
  type ActivityEvent,
  type ActivityEventType,
  type ActivityJson,
  type ActivityLink,
  type ActivityStatus,
} from './contract.js';

export type ValidateEventResult = { readonly ok: true; readonly event: ActivityEvent } | { readonly ok: false; readonly reason: string };
export type ValidateBatchResult = { readonly ok: true; readonly batch: ActivityBatch } | { readonly ok: false; readonly reason: string };

const EVENT_TYPES: readonly ActivityEventType[] = ['start', 'update', 'end', 'annotate'];
const STATUSES: readonly ActivityStatus[] = ['running', 'success', 'error', 'cancelled', 'skipped'];

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isEventType(value: unknown): value is ActivityEventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is ActivityStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

const CONTEXT_NOT_JSON_REASON = 'event.context must be a JSON-serialisable object';

/**
 * Walks `root` (event.context) with an explicit work stack instead of recursion,
 * enforcing a depth cap and a total-node cap, so a hostile shape (deeply nested
 * arrays/objects, or a circular reference reachable only via direct object
 * construction rather than JSON.parse) can never overflow the stack or loop
 * forever -- it fails fast with a stable reason instead (validateEvent's
 * documented "never throws" guarantee).
 */
function checkActivityJson(root: unknown): { ok: true } | { ok: false; reason: string } {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let nodeCount = 0;

  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;

    nodeCount++;
    if (nodeCount > ACTIVITY_LIMITS.maxContextNodes) {
      return fail(`event.context exceeds maxContextNodes (${ACTIVITY_LIMITS.maxContextNodes})`);
    }
    if (depth > ACTIVITY_LIMITS.maxContextDepth) {
      return fail(`event.context exceeds maxContextDepth (${ACTIVITY_LIMITS.maxContextDepth})`);
    }

    if (value === null) continue;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') continue;
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (t === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    return fail(CONTEXT_NOT_JSON_REASON);
  }

  return { ok: true };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validateActor(raw: unknown): { ok: true; value: ActivityActor } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return fail('event.actor must be an object');
  if (!isNonEmptyString(raw.id)) return fail('event.actor.id must be a non-empty string');
  if (raw.name !== undefined && !isString(raw.name)) return fail('event.actor.name must be a string');
  if (raw.kind !== undefined && !isString(raw.kind)) return fail('event.actor.kind must be a string');
  const value: ActivityActor = {
    id: raw.id,
    ...(raw.name !== undefined ? { name: raw.name as string } : {}),
    ...(raw.kind !== undefined ? { kind: raw.kind as string } : {}),
  };
  return { ok: true, value };
}

function validateLink(raw: unknown): { ok: true; value: ActivityLink } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return fail('event.link must be an object');
  if (!isNonEmptyString(raw.parentFlow)) return fail('event.link.parentFlow must be a non-empty string');
  if (raw.parentOp !== undefined && !isString(raw.parentOp)) return fail('event.link.parentOp must be a string');
  if (raw.parentNode !== undefined && !isString(raw.parentNode)) return fail('event.link.parentNode must be a string');
  if (raw.trace !== undefined && !isNonEmptyString(raw.trace)) return fail('event.link.trace must be a non-empty string');
  const value: ActivityLink = {
    parentFlow: raw.parentFlow,
    ...(raw.parentOp !== undefined ? { parentOp: raw.parentOp as string } : {}),
    ...(raw.parentNode !== undefined ? { parentNode: raw.parentNode as string } : {}),
    ...(raw.trace !== undefined ? { trace: raw.trace as string } : {}),
  };
  return { ok: true, value };
}

/** Validate one event against the wire contract. Never throws. */
export function validateEvent(raw: unknown): ValidateEventResult {
  if (!isPlainObject(raw)) return fail('event must be an object');

  if (raw.v !== ACTIVITY_CONTRACT_VERSION) return fail(`event.v must equal ${ACTIVITY_CONTRACT_VERSION}`);

  if (!isNonEmptyString(raw.id)) return fail('event.id must be a non-empty string');
  if (raw.id.length > ACTIVITY_LIMITS.maxIdLength) return fail(`event.id exceeds maxIdLength (${ACTIVITY_LIMITS.maxIdLength})`);

  if (!isFiniteNumber(raw.ts)) return fail('event.ts must be a finite number');

  let seq: number | undefined;
  if (raw.seq !== undefined) {
    if (!isFiniteNumber(raw.seq)) return fail('event.seq must be a finite number');
    seq = raw.seq;
  }

  if (!isNonEmptyString(raw.flow)) return fail('event.flow must be a non-empty string');
  if (!isNonEmptyString(raw.op)) return fail('event.op must be a non-empty string');
  if (!isNonEmptyString(raw.node)) return fail('event.node must be a non-empty string');

  if (!isEventType(raw.type)) return fail('event.type must be one of start, update, end, annotate');

  if (!isNonEmptyString(raw.name)) return fail('event.name must be a non-empty string');

  let kind: string | undefined;
  if (raw.kind !== undefined) {
    if (!isString(raw.kind)) return fail('event.kind must be a string');
    kind = raw.kind;
  }

  let label: string | undefined;
  if (raw.label !== undefined) {
    if (!isString(raw.label)) return fail('event.label must be a string');
    label = raw.label;
  }

  let relation: string | undefined;
  if (raw.relation !== undefined) {
    if (!isString(raw.relation)) return fail('event.relation must be a string');
    relation = raw.relation;
  }

  let parentOp: string | null | undefined;
  if (raw.parentOp !== undefined) {
    if (raw.parentOp !== null && !isString(raw.parentOp)) return fail('event.parentOp must be a string or null');
    parentOp = raw.parentOp as string | null;
  }

  let parentNode: string | null | undefined;
  if (raw.parentNode !== undefined) {
    if (raw.parentNode !== null && !isString(raw.parentNode)) return fail('event.parentNode must be a string or null');
    parentNode = raw.parentNode as string | null;
  }

  let root: boolean | undefined;
  if (raw.root !== undefined) {
    if (typeof raw.root !== 'boolean') return fail('event.root must be a boolean');
    root = raw.root;
  }

  let dataFrom: string | undefined;
  if (raw.dataFrom !== undefined) {
    if (!isNonEmptyString(raw.dataFrom)) return fail('event.dataFrom must be a non-empty string');
    dataFrom = raw.dataFrom;
  }

  let status: ActivityStatus | undefined;
  if (raw.status !== undefined) {
    if (!isStatus(raw.status)) return fail('event.status must be one of running, success, error, cancelled, skipped');
    status = raw.status;
  }

  let durationMs: number | undefined;
  if (raw.durationMs !== undefined) {
    if (!isFiniteNumber(raw.durationMs) || raw.durationMs < 0) return fail('event.durationMs must be a non-negative finite number');
    durationMs = raw.durationMs;
  }

  let actor: ActivityActor | undefined;
  if (raw.actor !== undefined) {
    const result = validateActor(raw.actor);
    if (!result.ok) return fail(result.reason);
    actor = result.value;
  }

  let link: ActivityLink | undefined;
  if (raw.link !== undefined) {
    const result = validateLink(raw.link);
    if (!result.ok) return fail(result.reason);
    link = result.value;
  }

  let context: ActivityContext | undefined;
  if (raw.context !== undefined) {
    if (!isPlainObject(raw.context)) return fail(CONTEXT_NOT_JSON_REASON);
    const check = checkActivityJson(raw.context);
    if (!check.ok) return fail(check.reason);
    context = raw.context as ActivityContext;
  }

  let tags: readonly string[] | undefined;
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || !raw.tags.every(isString)) return fail('event.tags must be an array of strings');
    if (raw.tags.length > ACTIVITY_LIMITS.maxTags) return fail(`event.tags exceeds maxTags (${ACTIVITY_LIMITS.maxTags})`);
    tags = [...(raw.tags as string[])];
  }

  const event: ActivityEvent = {
    v: ACTIVITY_CONTRACT_VERSION,
    id: raw.id,
    ts: raw.ts as number,
    ...(seq !== undefined ? { seq } : {}),
    flow: raw.flow,
    op: raw.op,
    node: raw.node,
    type: raw.type as ActivityEventType,
    name: raw.name,
    ...(kind !== undefined ? { kind } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(relation !== undefined ? { relation } : {}),
    ...(parentOp !== undefined ? { parentOp } : {}),
    ...(parentNode !== undefined ? { parentNode } : {}),
    ...(root !== undefined ? { root } : {}),
    ...(dataFrom !== undefined ? { dataFrom } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(actor !== undefined ? { actor } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };

  // event.context has already been walked and bounded above, so this should never
  // throw -- but a circular or otherwise exotic value reachable only via direct
  // object construction (not JSON.parse) must still never escape as a throw.
  let serialised: string;
  try {
    serialised = JSON.stringify(event);
  } catch {
    return fail(CONTEXT_NOT_JSON_REASON);
  }
  const bytes = byteLength(serialised);
  if (bytes > ACTIVITY_LIMITS.maxEventBytes) return fail(`event exceeds maxEventBytes (${ACTIVITY_LIMITS.maxEventBytes})`);

  return { ok: true, event };
}

/** Validate a batch envelope. Each event is validated with validateEvent; the first failure wins. */
export function validateBatch(raw: unknown): ValidateBatchResult {
  if (!isPlainObject(raw)) return fail('batch must be an object');

  if (raw.v !== ACTIVITY_CONTRACT_VERSION) return fail(`batch.v must equal ${ACTIVITY_CONTRACT_VERSION}`);

  let workspace: string | undefined;
  if (raw.workspace !== undefined) {
    if (!isNonEmptyString(raw.workspace)) return fail('batch.workspace must be a non-empty string');
    workspace = raw.workspace;
  }

  if (!Array.isArray(raw.events)) return fail('batch.events must be an array');
  if (raw.events.length > ACTIVITY_LIMITS.maxEventsPerBatch) {
    return fail(`batch.events exceeds maxEventsPerBatch (${ACTIVITY_LIMITS.maxEventsPerBatch})`);
  }

  const events: ActivityEvent[] = [];
  for (let index = 0; index < raw.events.length; index++) {
    const result = validateEvent(raw.events[index]);
    if (!result.ok) return fail(`event at index ${index}: ${result.reason}`);
    events.push(result.event);
  }

  const batch: ActivityBatch = { v: ACTIVITY_CONTRACT_VERSION, ...(workspace !== undefined ? { workspace } : {}), events };
  return { ok: true, batch };
}
