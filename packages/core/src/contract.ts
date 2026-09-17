/**
 * Tracery wire contract, version 1.
 *
 * This file is the source of truth for every producer (TS client, Python client,
 * Virali/Saga adapters), the hub server and the reducers. Changing a field here is
 * a contract change: bump ACTIVITY_CONTRACT_VERSION and add a golden test.
 *
 * Vocabulary
 *   flow   one run of work that produces one graph: an invocation, a job, a session.
 *   op     one call instance inside a flow; its start/update/end events share the op id.
 *   node   a reusable component identity inside a flow ("llm:main", "tool:search").
 *          Many ops can land on one node; the node accumulates their history.
 *   trace  a tree of flows linked by `link` on each child flow's root start.
 *   actor  who ran the flow (an agent, a subagent, a service). Optional but
 *          recommended: trace views namespace node identities by actor.
 */

export const ACTIVITY_CONTRACT_VERSION = 1 as const;

/** Lifecycle phase carried by one event. */
export type ActivityEventType = 'start' | 'update' | 'end' | 'annotate';

/** Terminal and non-terminal op statuses. `running` is implied by a start without end. */
export type ActivityStatus = 'running' | 'success' | 'error' | 'cancelled' | 'skipped';

/** JSON-serialisable context. Producers may put anything here; the hub bounds its size. */
export type ActivityContext = { readonly [key: string]: ActivityJson };
export type ActivityJson = string | number | boolean | null | readonly ActivityJson[] | { readonly [key: string]: ActivityJson };

export interface ActivityActor {
  /** Stable identity, e.g. "agent:saga", "agent:virali/subagent:research-7". */
  readonly id: string;
  readonly name?: string;
  /** Free category used by presentation catalogs: "agent", "subagent", "service", "human". */
  readonly kind?: string;
}

/**
 * Present only on the ROOT start event of a flow that was spawned by another flow.
 * It is how a subagent's graph attaches to its caller's graph.
 */
export interface ActivityLink {
  /** The flow that spawned this one. */
  readonly parentFlow: string;
  /** The op inside the parent flow that did the spawning, when known. */
  readonly parentOp?: string;
  /** The node inside the parent flow that did the spawning, when known. */
  readonly parentNode?: string;
  /**
   * Explicit trace id. When absent the trace id is the root ancestor's flow id,
   * resolved by walking parentFlow links. Set it when the parent flow may never
   * be observed by the same hub (cross-system spawning).
   */
  readonly trace?: string;
}

export interface ActivityEvent {
  readonly v: typeof ACTIVITY_CONTRACT_VERSION;
  /** Globally unique event id; the deduplication key. ULID or UUID recommended. */
  readonly id: string;
  /** Epoch milliseconds at the producer. */
  readonly ts: number;
  /** Optional producer-side monotonic sequence within the flow. The hub assigns its own cursor. */
  readonly seq?: number;

  readonly flow: string;
  readonly op: string;
  readonly node: string;
  readonly type: ActivityEventType;

  /** Operation name, e.g. "llm.provider", "tool.call", "memory.retrieve". */
  readonly name: string;
  /** Node category consumed by presentation catalogs, e.g. "llm", "tool", "agent". */
  readonly kind?: string;
  /** Human label for the node. The first non-empty label observed wins; later ones update it. */
  readonly label?: string;
  /** Directed edge purpose from parent node to this node: "invoke", "deliver", "listen". Defaults to "invoke". */
  readonly relation?: string;

  /** Explicit call-context parent inside the same flow; never inferred from arrival order. */
  readonly parentOp?: string | null;
  /** The parent op's node, so an edge can render before the parent's events arrive. */
  readonly parentNode?: string | null;
  /** True when the op began with no parent in its flow. The first root start defines the flow. */
  readonly root?: boolean;
  /** Explicit data dependency: this op consumed the output of that node. Draws an edge without implying call parentage. */
  readonly dataFrom?: string;

  /** Required on `end`; optional elsewhere. */
  readonly status?: ActivityStatus;
  /** Monotonic elapsed time reported on `end`. */
  readonly durationMs?: number;

  readonly actor?: ActivityActor;
  /** Only meaningful on a flow's root start. Ignored elsewhere. */
  readonly link?: ActivityLink;

  /**
   * Rich context. `start`/`update`/`end` contexts are shallow-merged into the op's
   * context in event order; `annotate` events are kept as discrete timeline entries.
   * Producers must not put raw prompts, secrets or PII here unless their hub is scoped for it.
   */
  readonly context?: ActivityContext;
  readonly tags?: readonly string[];
}

/** Ingest request body: POST /v1/events */
export interface ActivityBatch {
  readonly v: typeof ACTIVITY_CONTRACT_VERSION;
  /** Hub workspace. Optional when the API key is bound to one workspace. */
  readonly workspace?: string;
  readonly events: readonly ActivityEvent[];
}

export interface ActivityBatchResult {
  readonly accepted: number;
  /** Events already seen (same id). Not an error. */
  readonly duplicates: number;
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
  /** Hub cursor after this batch; clients resume live feeds from it. */
  readonly cursor: number;
}

/** Live feed frames: WS /v1/live and GET /v1/flows/:id/events?after= */
export type ActivityFrame =
  | { readonly type: 'snapshot'; readonly cursor: number; readonly events: readonly StoredEvent[]; readonly truncated: boolean }
  | { readonly type: 'events'; readonly cursor: number; readonly events: readonly StoredEvent[] }
  | { readonly type: 'heartbeat'; readonly cursor: number };

/** An event as persisted by the hub: the producer event plus hub bookkeeping. */
export interface StoredEvent extends ActivityEvent {
  readonly workspace: string;
  /** Hub-wide monotonic cursor. */
  readonly cursor: number;
  /** Epoch ms when the hub accepted it. */
  readonly receivedAt: number;
}

/** Hub limits producers can rely on. */
export const ACTIVITY_LIMITS = {
  maxEventsPerBatch: 1000,
  maxEventBytes: 64 * 1024,
  maxIdLength: 256,
  maxTags: 32,
  /** Maximum nesting depth walked inside event.context. Guards validateEvent's "never throws" guarantee against a deeply nested body. */
  maxContextDepth: 32,
  /** Maximum number of JSON nodes (objects, arrays, and scalars) walked inside event.context. */
  maxContextNodes: 10_000,
} as const;
