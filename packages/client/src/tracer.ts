import type {
  ActivityActor,
  ActivityContext,
  ActivityEvent,
  ActivityLink,
  ActivityStatus,
} from '@atriarch-systems/tracery-core';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch-systems/tracery-core';
import { ulid } from './ulid.js';
import type { ActivityTransport, Clock } from './types.js';
import { defaultClock } from './types.js';

type EventInput = Omit<ActivityEvent, 'v' | 'id' | 'ts' | 'seq'>;
type EmitFn = (input: EventInput) => void;

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) if (val !== undefined) out[key] = val;
  return out as T;
}

// ---------------------------------------------------------------------------
// Op
// ---------------------------------------------------------------------------

export interface OpStartOptions {
  readonly node: string;
  readonly name: string;
  readonly kind?: string;
  readonly label?: string;
  /** Explicit call-context parent op inside the same flow. */
  readonly parent?: Op;
  readonly relation?: string;
  readonly dataFrom?: string;
  readonly context?: ActivityContext;
  readonly tags?: readonly string[];
}

export interface OpUpdateOptions {
  readonly status?: ActivityStatus;
  readonly context?: ActivityContext;
}

export interface OpAnnotateOptions {
  readonly context?: ActivityContext;
  readonly tags?: readonly string[];
}

export interface OpEndOptions {
  /** Defaults to `'success'`. */
  readonly status?: ActivityStatus;
  readonly context?: ActivityContext;
  /** Overrides the value computed from the clock's monotonic reading at `start`. */
  readonly durationMs?: number;
}

/** @internal fields Flow uses to construct an Op; not part of the public surface. */
interface OpInit {
  readonly id: string;
  readonly flow: string;
  readonly node: string;
  readonly name: string;
  readonly emit: EmitFn;
  readonly clock: Clock;
  readonly kind?: string;
  readonly label?: string;
  readonly parentOp?: string;
  readonly parentNode?: string;
  readonly root?: boolean;
  readonly relation?: string;
  readonly dataFrom?: string;
  readonly actor?: ActivityActor;
  readonly link?: ActivityLink;
  readonly context?: ActivityContext;
  readonly tags?: readonly string[];
}

/** One call instance inside a flow. Created by `Flow.start` (or the flow's own root op). */
export class Op {
  readonly id: string;
  readonly flow: string;
  readonly node: string;
  readonly name: string;

  private readonly emit: EmitFn;
  private readonly clock: Clock;
  private readonly startedAtMonotonic: number;
  private ended = false;

  /** @internal use `Flow.start` or `ActivityTracer.startFlow`. */
  constructor(init: OpInit) {
    this.id = init.id;
    this.flow = init.flow;
    this.node = init.node;
    this.name = init.name;
    this.emit = init.emit;
    this.clock = init.clock;
    this.startedAtMonotonic = this.clock.monotonic();
    this.emit({
      flow: init.flow,
      op: init.id,
      node: init.node,
      type: 'start',
      name: init.name,
      kind: init.kind,
      label: init.label,
      parentOp: init.parentOp,
      parentNode: init.parentNode,
      root: init.root,
      relation: init.relation,
      dataFrom: init.dataFrom,
      actor: init.actor,
      link: init.link,
      context: init.context,
      tags: init.tags,
    });
  }

  /** True once `end()` has been called locally. */
  get isEnded(): boolean {
    return this.ended;
  }

  update(options: OpUpdateOptions = {}): void {
    if (this.ended) return;
    this.emit({
      flow: this.flow,
      op: this.id,
      node: this.node,
      type: 'update',
      name: this.name,
      status: options.status,
      context: options.context,
    });
  }

  annotate(options: OpAnnotateOptions = {}): void {
    this.emit({
      flow: this.flow,
      op: this.id,
      node: this.node,
      type: 'annotate',
      name: this.name,
      context: options.context,
      tags: options.tags,
    });
  }

  end(options: OpEndOptions = {}): void {
    if (this.ended) return;
    this.ended = true;
    const durationMs = options.durationMs ?? this.clock.monotonic() - this.startedAtMonotonic;
    this.emit({
      flow: this.flow,
      op: this.id,
      node: this.node,
      type: 'end',
      name: this.name,
      status: options.status ?? 'success',
      durationMs,
      context: options.context,
    });
  }
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export interface StartFlowOptions {
  readonly id?: string;
  readonly label?: string;
  readonly link?: ActivityLink;
  readonly context?: ActivityContext;
  readonly actor?: ActivityActor;
}

/** @internal fields ActivityTracer uses to construct a Flow. */
interface FlowInit {
  readonly id: string;
  readonly emit: EmitFn;
  readonly clock: Clock;
  readonly actor?: ActivityActor;
  readonly label?: string;
  readonly link?: ActivityLink;
  readonly context?: ActivityContext;
}

/**
 * One run of work producing one graph. Created by `ActivityTracer.startFlow`,
 * which also starts the flow's root op. `spawnLink` hands a subagent flow the
 * `ActivityLink` it needs to attach its own root start to this one.
 */
export class Flow {
  readonly id: string;
  /** The root op started for this flow (`node` defaults to `actor?.id ?? 'flow'`). */
  readonly rootOp: Op;

  private readonly emit: EmitFn;
  private readonly clock: Clock;
  private readonly actor?: ActivityActor;
  /**
   * This flow's own resolved trace id, when knowable client-side: the
   * explicit `link.trace` it was given, or its own id when it has no link
   * (a flow with no link is a trace root). Undefined when this flow was
   * itself spawned without an explicit trace — only the hub can resolve
   * that by walking ancestry.
   */
  private readonly knownTrace: string | undefined;

  /** @internal use `ActivityTracer.startFlow`. */
  constructor(init: FlowInit) {
    this.id = init.id;
    this.emit = init.emit;
    this.clock = init.clock;
    this.actor = init.actor;
    this.knownTrace = init.link ? init.link.trace : init.id;

    this.rootOp = new Op({
      id: ulid(),
      flow: init.id,
      node: init.actor?.id ?? 'flow',
      name: 'flow',
      kind: init.actor?.kind ?? 'agent',
      label: init.label,
      root: true,
      actor: init.actor,
      link: init.link,
      context: init.context,
      emit: this.emit,
      clock: this.clock,
    });
  }

  start(options: OpStartOptions): Op {
    return new Op({
      id: ulid(),
      flow: this.id,
      node: options.node,
      name: options.name,
      kind: options.kind,
      label: options.label,
      parentOp: options.parent?.id,
      parentNode: options.parent?.node,
      relation: options.relation,
      dataFrom: options.dataFrom,
      actor: this.actor,
      context: options.context,
      tags: options.tags,
      emit: this.emit,
      clock: this.clock,
    });
  }

  /**
   * Build the `ActivityLink` a subagent flow needs to attach to this flow.
   * Defaults to spawning from the flow's root op; pass the op that actually
   * did the spawning to attach the edge there instead.
   */
  spawnLink(op?: Op): ActivityLink {
    const source = op ?? this.rootOp;
    return this.knownTrace === undefined
      ? { parentFlow: this.id, parentOp: source.id, parentNode: source.node }
      : { parentFlow: this.id, parentOp: source.id, parentNode: source.node, trace: this.knownTrace };
  }

  /** Ends the flow's root op. */
  end(options: { status?: ActivityStatus; context?: ActivityContext } = {}): void {
    this.rootOp.end(options);
  }
}

// ---------------------------------------------------------------------------
// ActivityTracer
// ---------------------------------------------------------------------------

export interface ActivityTracerOptions {
  readonly transport: ActivityTransport;
  readonly actor?: ActivityActor;
  /** How often queued events are flushed to the transport. Default 250ms. */
  readonly flushIntervalMs?: number;
  /** Max events per `transport.send` call. Default 500. */
  readonly maxBatch?: number;
  /** Max events held in the pending queue before new ones are dropped. Default 10000. */
  readonly maxQueue?: number;
  readonly clock?: Clock;
}

/**
 * Batches events produced by flows/ops and periodically hands them to a
 * transport. One tracer per process is typical; each `startFlow` call opens
 * a new flow that shares the tracer's queue, actor default and clock.
 */
export class ActivityTracer {
  private readonly transport: ActivityTransport;
  private readonly actor?: ActivityActor;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly clock: Clock;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly emit: EmitFn;
  private queue: ActivityEvent[] = [];
  private droppedCount = 0;
  private seq = 0;
  private closed = false;
  /** Set while a drain is in flight so overlapping `flush()` callers share it instead of starting another. */
  private inFlight: Promise<void> | null = null;

  constructor(options: ActivityTracerOptions) {
    this.transport = options.transport;
    this.actor = options.actor;
    this.maxBatch = options.maxBatch ?? 500;
    this.maxQueue = options.maxQueue ?? 10000;
    this.clock = options.clock ?? defaultClock;
    const flushIntervalMs = options.flushIntervalMs ?? 250;

    this.emit = (input) => {
      if (this.closed) return;
      if (this.queue.length >= this.maxQueue) {
        this.droppedCount++;
        return;
      }
      const event = stripUndefined({
        v: ACTIVITY_CONTRACT_VERSION,
        id: ulid(),
        ts: this.clock.now(),
        seq: this.seq++,
        ...input,
      }) as ActivityEvent;
      this.queue.push(event);
    };

    this.timer = setInterval(() => {
      void this.flush();
    }, flushIntervalMs);
    // Node's timer handle has `unref()` so a pending flush interval never
    // keeps a process alive; browsers have no such concept. Feature-detect
    // rather than depending on `@types/node` (this package stays isomorphic).
    const handle = this.timer as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') handle.unref();
  }

  /** Events dropped locally because the queue exceeded `maxQueue`. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Start a new flow, emitting its root `start` event immediately. */
  startFlow(options: StartFlowOptions): Flow {
    const id = options.id ?? ulid();
    return new Flow({
      id,
      emit: this.emit,
      clock: this.clock,
      actor: options.actor ?? this.actor,
      label: options.label,
      link: options.link,
      context: options.context,
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatch);
      try {
        await this.transport.send(batch);
      } catch {
        // Transports are expected to swallow their own errors; this guard
        // just keeps a misbehaving one from breaking the flush loop.
      }
    }
    try {
      await this.transport.flush?.();
    } catch {
      // ignore
    }
  }

  /**
   * Drain the queue to the transport in `maxBatch`-sized chunks. Never
   * throws. Re-entrant: if a drain is already running (started by this call,
   * another concurrent `flush()`, or the periodic timer), this awaits that
   * same drain instead of starting an overlapping one — so `transport.send`
   * never runs concurrently with itself and `await flush()` only resolves
   * once every batch queued up to that point (including ones spliced off by
   * the in-progress drain) has actually been handed to the transport.
   */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.drain().finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  /** Flush remaining events, stop the flush timer, and close the transport. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.flush();
    try {
      await this.transport.close?.();
    } catch {
      // ignore
    }
  }
}
