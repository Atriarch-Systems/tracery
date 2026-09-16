"""ActivityTracer, Flow and Op: the Python emitter SDK (mirrors the TypeScript
``@atriarch/activity-client`` tracer.ts, snake_cased). See docs/SPEC.md §5.
"""

from __future__ import annotations

import contextlib
import contextvars
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from .events import ACTIVITY_CONTRACT_VERSION, ActivityActor, ActivityContext, ActivityLink, ActivityStatus
from .ulid import ulid

EmitFn = Callable[[dict[str, Any]], None]


class Transport(Protocol):
    """Sink an ``ActivityTracer`` flushes batches of events into.

    Implementations must never raise into the caller: swallow (and
    optionally log) failures. ``flush``/``close`` are optional.
    """

    def send(self, events: list[dict[str, Any]]) -> None: ...

    def flush(self) -> None: ...  # pragma: no cover - optional

    def close(self) -> None: ...  # pragma: no cover - optional


@dataclass(frozen=True)
class Clock:
    """Time source. ``now()`` supplies the wire ``ts`` (epoch milliseconds,
    an int); ``monotonic()`` supplies the clock ``end()`` uses to compute
    ``durationMs`` (milliseconds, may be fractional). Overridable for tests.
    """

    now: Callable[[], int]
    monotonic: Callable[[], float]


DEFAULT_CLOCK = Clock(now=lambda: int(time.time() * 1000), monotonic=lambda: time.perf_counter() * 1000)

# Propagates the flow/op currently "in scope" on this thread/task, so a
# nested `flow.start(...)` call made without an explicit `parent=` picks up
# the current op automatically. Survives `contextvars.copy_context()` across
# `threading.Thread`, which is how you hand a background thread the right
# call-context parent.
current_flow: contextvars.ContextVar["Flow | None"] = contextvars.ContextVar(
    "atriarch_activity_current_flow", default=None
)
current_op: contextvars.ContextVar["Op | None"] = contextvars.ContextVar(
    "atriarch_activity_current_op", default=None
)


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


class Op:
    """One call instance inside a flow. Created by ``Flow.start`` (or the
    flow's own root op, created by ``ActivityTracer.start_flow``).
    """

    def __init__(
        self,
        *,
        id: str,
        flow: str,
        node: str,
        name: str,
        emit: EmitFn,
        clock: Clock,
        kind: str | None = None,
        label: str | None = None,
        parent_op: str | None = None,
        parent_node: str | None = None,
        root: bool | None = None,
        relation: str | None = None,
        data_from: str | None = None,
        actor: ActivityActor | None = None,
        link: ActivityLink | None = None,
        context: ActivityContext | None = None,
        tags: list[str] | None = None,
    ) -> None:
        self.id = id
        self.flow = flow
        self.node = node
        self.name = name
        self._emit = emit
        self._clock = clock
        self._started_at_monotonic = clock.monotonic()
        self._ended = False
        self._emit(
            _drop_none(
                {
                    "flow": flow,
                    "op": id,
                    "node": node,
                    "type": "start",
                    "name": name,
                    "kind": kind,
                    "label": label,
                    "parentOp": parent_op,
                    "parentNode": parent_node,
                    "root": root,
                    "relation": relation,
                    "dataFrom": data_from,
                    "actor": actor,
                    "link": link,
                    "context": context,
                    "tags": tags,
                }
            )
        )

    @property
    def is_ended(self) -> bool:
        return self._ended

    def update(self, *, status: ActivityStatus | None = None, context: ActivityContext | None = None) -> None:
        if self._ended:
            return
        self._emit(
            _drop_none(
                {
                    "flow": self.flow,
                    "op": self.id,
                    "node": self.node,
                    "type": "update",
                    "name": self.name,
                    "status": status,
                    "context": context,
                }
            )
        )

    def annotate(self, *, context: ActivityContext | None = None, tags: list[str] | None = None) -> None:
        self._emit(
            _drop_none(
                {
                    "flow": self.flow,
                    "op": self.id,
                    "node": self.node,
                    "type": "annotate",
                    "name": self.name,
                    "context": context,
                    "tags": tags,
                }
            )
        )

    def end(
        self,
        *,
        status: ActivityStatus | None = None,
        context: ActivityContext | None = None,
        duration_ms: float | None = None,
    ) -> None:
        if self._ended:
            return
        self._ended = True
        computed = duration_ms if duration_ms is not None else (self._clock.monotonic() - self._started_at_monotonic)
        self._emit(
            _drop_none(
                {
                    "flow": self.flow,
                    "op": self.id,
                    "node": self.node,
                    "type": "end",
                    "name": self.name,
                    "status": status if status is not None else "success",
                    "durationMs": computed,
                    "context": context,
                }
            )
        )


class Flow:
    """One run of work producing one graph. Created by
    ``ActivityTracer.start_flow``, which also starts the flow's root op.
    ``spawn_link`` hands a subagent flow the ``ActivityLink`` it needs to
    attach its own root start to this one.
    """

    def __init__(
        self,
        *,
        id: str,
        emit: EmitFn,
        clock: Clock,
        actor: ActivityActor | None = None,
        label: str | None = None,
        link: ActivityLink | None = None,
        context: ActivityContext | None = None,
    ) -> None:
        self.id = id
        self._emit = emit
        self._clock = clock
        self._actor = actor

        # This flow's own resolved trace id, when knowable client-side: the
        # explicit link["trace"] it was given, or its own id when it has no
        # link (a flow with no link is a trace root). None when this flow
        # was itself spawned without an explicit trace -- only the hub can
        # resolve that by walking ancestry.
        if link is None:
            self._known_trace: str | None = id
        else:
            self._known_trace = link.get("trace")

        node = actor.get("id", "flow") if actor else "flow"
        kind = actor.get("kind", "agent") if actor else "agent"
        self.root_op = Op(
            id=ulid(),
            flow=id,
            node=node,
            name="flow",
            kind=kind,
            label=label,
            root=True,
            actor=actor,
            link=link,
            context=context,
            emit=self._emit,
            clock=self._clock,
        )

    def start(
        self,
        *,
        node: str,
        name: str,
        kind: str | None = None,
        label: str | None = None,
        parent: "Op | None" = None,
        relation: str | None = None,
        data_from: str | None = None,
        context: ActivityContext | None = None,
        tags: list[str] | None = None,
    ) -> Op:
        implicit_parent = parent
        if implicit_parent is None:
            candidate = current_op.get()
            if candidate is not None and candidate.flow == self.id:
                implicit_parent = candidate
        return Op(
            id=ulid(),
            flow=self.id,
            node=node,
            name=name,
            kind=kind,
            label=label,
            parent_op=implicit_parent.id if implicit_parent else None,
            parent_node=implicit_parent.node if implicit_parent else None,
            relation=relation,
            data_from=data_from,
            actor=self._actor,
            context=context,
            tags=tags,
            emit=self._emit,
            clock=self._clock,
        )

    @contextlib.contextmanager
    def op(
        self,
        *,
        node: str,
        name: str,
        kind: str | None = None,
        label: str | None = None,
        parent: "Op | None" = None,
        relation: str | None = None,
        data_from: str | None = None,
        context: ActivityContext | None = None,
        tags: list[str] | None = None,
    ):
        """``with flow.op(node=..., name=...) as op:``

        Starts an op and makes it (and this flow) the "current" one for the
        duration of the block via contextvars, so a nested ``flow.start(...)``
        inside picks it up as an implicit parent without explicit plumbing.
        Ends the op on exit: ``success`` normally, or ``error`` with
        ``context={"error": exc.__class__.__name__}`` (class name only, no
        message -- avoid leaking exception text into stored context) if the
        block raised. The exception is always re-raised.
        """
        started = self.start(
            node=node,
            name=name,
            kind=kind,
            label=label,
            parent=parent,
            relation=relation,
            data_from=data_from,
            context=context,
            tags=tags,
        )
        flow_token = current_flow.set(self)
        op_token = current_op.set(started)
        try:
            yield started
        except BaseException as exc:
            started.end(status="error", context={"error": type(exc).__name__})
            raise
        else:
            started.end(status="success")
        finally:
            current_op.reset(op_token)
            current_flow.reset(flow_token)

    def spawn_link(self, op: "Op | None" = None) -> ActivityLink:
        source = op or self.root_op
        link: dict[str, Any] = {"parentFlow": self.id, "parentOp": source.id, "parentNode": source.node}
        if self._known_trace is not None:
            link["trace"] = self._known_trace
        return link  # type: ignore[return-value]

    def end(self, *, status: ActivityStatus | None = None, context: ActivityContext | None = None) -> None:
        self.root_op.end(status=status, context=context)


class ActivityTracer:
    """Batches events produced by flows/ops and periodically hands them to a
    transport. One tracer per process is typical; each ``start_flow`` call
    opens a new flow that shares the tracer's queue, actor default and clock.
    """

    def __init__(
        self,
        *,
        transport: Transport,
        actor: ActivityActor | None = None,
        flush_interval_ms: float = 250,
        max_batch: int = 500,
        max_queue: int = 10000,
        clock: Clock | None = None,
    ) -> None:
        self._transport = transport
        self._actor = actor
        self._max_batch = max_batch
        self._max_queue = max_queue
        self._clock = clock or DEFAULT_CLOCK
        self._flush_interval_s = flush_interval_ms / 1000.0

        self._lock = threading.Lock()
        self._queue: list[dict[str, Any]] = []
        self._seq = 0
        self._dropped = 0
        self._closed = False

        self._timer: threading.Timer | None = None
        self._schedule_timer()

    # -- internal ----------------------------------------------------------

    def _schedule_timer(self) -> None:
        if self._closed:
            return
        timer = threading.Timer(self._flush_interval_s, self._on_timer)
        timer.daemon = True
        self._timer = timer
        timer.start()

    def _on_timer(self) -> None:
        self.flush()
        self._schedule_timer()

    def _emit(self, event: dict[str, Any]) -> None:
        with self._lock:
            if self._closed:
                return
            if len(self._queue) >= self._max_queue:
                self._dropped += 1
                return
            full: dict[str, Any] = {
                "v": ACTIVITY_CONTRACT_VERSION,
                "id": ulid(),
                "ts": self._clock.now(),
                "seq": self._seq,
            }
            self._seq += 1
            full.update(event)
            self._queue.append(full)

    # -- public API ----------------------------------------------------------

    @property
    def dropped(self) -> int:
        """Events dropped locally because the queue exceeded ``max_queue``."""
        return self._dropped

    def start_flow(
        self,
        *,
        id: str | None = None,
        label: str | None = None,
        link: ActivityLink | None = None,
        context: ActivityContext | None = None,
        actor: ActivityActor | None = None,
    ) -> Flow:
        """Start a new flow, emitting its root ``start`` event immediately."""
        flow_id = id or ulid()
        return Flow(
            id=flow_id,
            emit=self._emit,
            clock=self._clock,
            actor=actor if actor is not None else self._actor,
            label=label,
            link=link,
            context=context,
        )

    def flush(self) -> None:
        """Drain the queue to the transport in ``max_batch``-sized chunks. Never raises."""
        while True:
            with self._lock:
                if not self._queue:
                    break
                batch = self._queue[: self._max_batch]
                del self._queue[: self._max_batch]
            try:
                self._transport.send(batch)
            except Exception:
                # Transports are expected to swallow their own errors; this
                # guard just keeps a misbehaving one from breaking the flush loop.
                pass
        try:
            flush_fn = getattr(self._transport, "flush", None)
            if flush_fn is not None:
                flush_fn()
        except Exception:
            pass

    def close(self) -> None:
        """Flush remaining events, stop the flush timer, and close the transport."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
        timer = self._timer
        if timer is not None:
            timer.cancel()
        self.flush()
        try:
            close_fn = getattr(self._transport, "close", None)
            if close_fn is not None:
                close_fn()
        except Exception:
            pass
