"""Tracery Graph wire contract, version 1 (Python mirror).

This module mirrors ``packages/core/src/contract.ts``, the source of truth
for every producer (this client, the TypeScript client, the hub, the
reducers). Keep it in lockstep with that file; a wire-shape change there is
a contract change here too. Full semantics: ``docs/SPEC.md`` §1.

Vocabulary
    flow   one run of work that produces one graph: an invocation, a job, a session.
    op     one call instance inside a flow; its start/update/end events share the op id.
    node   a reusable component identity inside a flow ("llm:main", "tool:search").
           Many ops can land on one node; the node accumulates their history.
    trace  a tree of flows linked by ``link`` on each child flow's root start.
    actor  who ran the flow (an agent, a subagent, a service). Optional but
           recommended: trace views namespace node identities by actor.

Identity and deduplication
    ``id`` is the dedup key. Re-sending an event with the same id is a no-op.
    ``flow`` + ``op`` identify a call instance: one ``start`` per op (first
    wins; later starts for the same op are ignored), ``update``/``annotate``
    may repeat, one ``end`` per op (later ends ignored). ``flow`` + ``node``
    identify a graph node: ``kind``/``label`` update the node with the last
    observed value winning. Edge identity is ``(source node, target node,
    relation)`` inside a flow; counts are the number of distinct ``start``
    ops observed on that edge.

Ordering
    Events are processed in ``(ts, seq or 0, arrival)`` order inside a flow.
    Late events for a retained flow are always accepted and re-projected.

Op lifecycle
    ``start``    creates the op; status becomes ``running``; ``startedAt = ts``;
                 context merged.
    ``update``   context shallow-merged; status applied if given (a producer
                 may report ``error`` mid-op).
    ``end``      ``endedAt = ts``; status recorded (defaults to ``success``
                 if the producer omits it); ``durationMs`` recorded; context
                 merged.
    ``annotate`` appended to the op timeline verbatim; does not merge into
                 context or change status.
    An end/update/annotate whose op has no start still creates the op with
    ``startedAt`` unset and marks the flow partial.

Flow
    A flow is defined by its first ``root: true`` start. Fields: id, label
    (root op's label, else name), actor, startedAt, endedAt, status (error
    if any op errored, else running if any op open, else unknown if
    partial, else complete), link, trace, ops, nodes, edges.

Trace resolution
    ``trace`` for a flow = ``link.trace`` if set, else the trace of the flow
    named by ``link.parentFlow`` if known, else ``link.parentFlow`` (the
    parent may arrive later), else the flow's own id. A flow with no link is
    a trace root. Cycles are broken by treating the first flow seen as root.
"""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict, Union

ACTIVITY_CONTRACT_VERSION: Literal[1] = 1

ActivityEventType = Literal["start", "update", "end", "annotate"]
"""Lifecycle phase carried by one event."""

ActivityStatus = Literal["running", "success", "error", "cancelled", "skipped"]
"""Terminal and non-terminal op statuses. ``running`` is implied by a start without end."""

ActivityJson = Union[str, int, float, bool, None, list["ActivityJson"], dict[str, "ActivityJson"]]
"""JSON-serialisable value."""

ActivityContext = dict[str, ActivityJson]
"""Producers may put anything JSON-serialisable here; the hub bounds its size (64 KB/event)."""


class ActivityActor(TypedDict):
    """Who ran the flow."""

    id: str
    """Stable identity, e.g. "agent:saga", "agent:virali/subagent:research-7"."""
    name: NotRequired[str]
    kind: NotRequired[str]
    """Free category used by presentation catalogs: "agent", "subagent", "service", "human"."""


class ActivityLink(TypedDict):
    """Present only on the ROOT start event of a flow spawned by another flow.

    It is how a subagent's graph attaches to its caller's graph.
    """

    parentFlow: str
    """The flow that spawned this one."""
    parentOp: NotRequired[str]
    """The op inside the parent flow that did the spawning, when known."""
    parentNode: NotRequired[str]
    """The node inside the parent flow that did the spawning, when known."""
    trace: NotRequired[str]
    """
    Explicit trace id. When absent the trace id is the root ancestor's flow
    id, resolved by walking parentFlow links. Set it when the parent flow
    may never be observed by the same hub (cross-system spawning).
    """


class ActivityEvent(TypedDict):
    """One event on the wire. See the module docstring for full semantics."""

    v: Literal[1]
    id: str
    """Globally unique event id; the deduplication key. ULID or UUID recommended."""
    ts: int
    """Epoch milliseconds at the producer."""
    seq: NotRequired[int]
    """Optional producer-side monotonic sequence within the flow. The hub assigns its own cursor."""

    flow: str
    op: str
    node: str
    type: ActivityEventType

    name: str
    """Operation name, e.g. "llm.provider", "tool.call", "memory.retrieve"."""
    kind: NotRequired[str]
    """Node category consumed by presentation catalogs, e.g. "llm", "tool", "agent"."""
    label: NotRequired[str]
    """Human label for the node. The first non-empty label observed wins; later ones update it."""
    relation: NotRequired[str]
    """Directed edge purpose from parent node to this node: "invoke", "deliver", "listen". Defaults to "invoke"."""

    parentOp: NotRequired[str | None]
    """Explicit call-context parent inside the same flow; never inferred from arrival order."""
    parentNode: NotRequired[str | None]
    """The parent op's node, so an edge can render before the parent's events arrive."""
    root: NotRequired[bool]
    """True when the op began with no parent in its flow. The first root start defines the flow."""
    dataFrom: NotRequired[str]
    """Explicit data dependency: this op consumed the output of that node."""

    status: NotRequired[ActivityStatus]
    """Required on ``end``; optional elsewhere."""
    durationMs: NotRequired[float]
    """Monotonic elapsed time reported on ``end``."""

    actor: NotRequired[ActivityActor]
    link: NotRequired[ActivityLink]
    """Only meaningful on a flow's root start. Ignored elsewhere."""

    context: NotRequired[ActivityContext]
    """
    Rich context. start/update/end contexts are shallow-merged into the
    op's context in event order; annotate events are kept as discrete
    timeline entries. Producers must not put raw prompts, secrets or PII
    here unless their hub is scoped for it.
    """
    tags: NotRequired[list[str]]


class ActivityBatch(TypedDict):
    """Ingest request body: ``POST /v1/events``."""

    v: Literal[1]
    workspace: NotRequired[str]
    """Hub workspace. Optional when the API key is bound to one workspace."""
    events: list[ActivityEvent]


class RejectedEvent(TypedDict):
    index: int
    reason: str


class ActivityBatchResult(TypedDict):
    accepted: int
    duplicates: int
    """Events already seen (same id). Not an error."""
    rejected: list[RejectedEvent]
    cursor: int
    """Hub cursor after this batch; clients resume live feeds from it."""


ACTIVITY_LIMITS: dict[str, int] = {
    "max_events_per_batch": 1000,
    "max_event_bytes": 64 * 1024,
    "max_id_length": 256,
    "max_tags": 32,
}
"""Hub limits producers can rely on (mirrors contract.ts's ``ACTIVITY_LIMITS``)."""
