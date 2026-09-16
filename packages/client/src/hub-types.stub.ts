// NOTE: @atriarch/activity-core now ships flows.ts/trace.ts, so OpRecord,
// NodeRecord, EdgeRecord, TimelineEntry, FlowStatus and NodeStatus below are
// imported straight from it (type-only). What core does NOT (and cannot)
// give us is the hub's JSON wire shape for a `Flow`: core's `Flow.ops` /
// `Flow.nodes` are `ReadonlyMap`s, an in-process reducer detail that does
// not survive `JSON.stringify`/`JSON.parse`. `FlowSummary` and `Trace` below
// mirror docs/SPEC.md §2's `Flow`/`Trace` with those maps flattened to plain
// objects/arrays for the wire, per §6's `GET /v1/flows*` and `/v1/traces*`.
// The hub (workstream D) has not shipped yet, so the exact response
// envelopes (`ListFlowsResult` in particular) are still a best-effort
// reading of SPEC.md §6, not a confirmed schema -- revisit once the hub
// publishes its OpenAPI document at `/v1/openapi.json`.
import type {
  ActivityActor,
  ActivityLink,
  EdgeRecord,
  FlowStatus,
  NodeRecord,
  NodeStatus,
  OpRecord,
  TimelineEntry,
} from '@atriarch/activity-core';

export type { EdgeRecord, FlowStatus, NodeRecord, NodeStatus, OpRecord, TimelineEntry };

/** `GET /v1/flows/:id` response shape: a `Flow` with its node/edge records, no events. */
export interface FlowSummary {
  readonly id: string;
  readonly label: string;
  readonly actor?: ActivityActor;
  readonly status: FlowStatus;
  readonly partial: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly link?: ActivityLink;
  readonly trace: string;
  readonly ops: Readonly<Record<string, OpRecord>>;
  readonly nodes: Readonly<Record<string, NodeRecord>>;
  readonly edges: readonly EdgeRecord[];
}

/** `GET /v1/traces/:id` response shape. */
export interface Trace {
  readonly root: string;
  readonly flows: readonly FlowSummary[];
  readonly links: readonly {
    readonly parent: string;
    readonly child: string;
    readonly parentOp?: string;
    readonly parentNode?: string;
  }[];
  /** `link.parentFlow` ids referenced by a member flow but never observed. */
  readonly missing: readonly string[];
}

export interface ListFlowsQuery {
  readonly limit?: number;
  readonly before?: string;
  readonly status?: string;
  readonly actor?: string;
  readonly trace?: string;
  readonly q?: string;
}

/** `GET /v1/flows` response shape: newest first, with a cursor for the next page. */
export interface ListFlowsResult {
  readonly flows: readonly FlowSummary[];
  readonly nextBefore?: string;
}
