import contextvars
import threading
import time

import pytest

from atriarch.activity import ActivityTracer, Clock, MemoryTransport, current_op


def make_fake_clock():
    state = {"t": 0.0}

    def monotonic():
        state["t"] += 10
        return state["t"]

    return Clock(now=lambda: int(time.time() * 1000), monotonic=monotonic)


def test_batches_by_interval_and_chunks_by_max_batch():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=30, max_batch=3, actor={"id": "agent:test", "kind": "agent"})
    flow = tracer.start_flow(label="batch test")  # 1 event: root start
    for i in range(5):
        op = flow.start(node=f"tool:{i}", name="tool.call")
        op.end()
    # 1 root start + 5 * (start + end) = 11 events total.
    time.sleep(0.15)
    flat = [e for batch in transport.batches for e in batch]
    assert len(flat) == 11
    assert len(transport.batches) == -(-11 // 3)  # ceil(11/3)
    for batch in transport.batches:
        assert len(batch) <= 3
    tracer.close()


def test_queue_bound_drops_events_past_max_queue_and_counts_them():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000, max_queue=5)
    flow = tracer.start_flow()  # 1 event
    for i in range(10):
        op = flow.start(node=f"tool:{i}", name="tool.call")
        op.end()  # 20 more attempted events; total attempted = 21
    assert tracer.dropped == 21 - 5
    tracer.flush()
    flat = [e for batch in transport.batches for e in batch]
    assert len(flat) == 5
    tracer.close()


def test_duration_ms_present_on_end_and_overridable():
    transport = MemoryTransport()
    clock = make_fake_clock()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000, clock=clock)
    flow = tracer.start_flow()  # one monotonic tick for the root op
    op = flow.start(node="llm:main", name="llm.provider")  # another tick
    op.end()  # another tick; duration = 10
    op2 = flow.start(node="llm:main", name="llm.provider")
    op2.end(duration_ms=555)
    tracer.close()

    events = [e for batch in transport.batches for e in batch]
    end1 = next(e for e in events if e["op"] == op.id and e["type"] == "end")
    end2 = next(e for e in events if e["op"] == op2.id and e["type"] == "end")
    assert end1["durationMs"] == 10
    assert end1["status"] == "success"
    assert end2["durationMs"] == 555


def test_spawn_link_shape_and_trace_resolution():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000)

    # No link: this flow is its own trace root, so trace is known.
    root_flow = tracer.start_flow()
    link_from_root = root_flow.spawn_link()
    assert link_from_root == {
        "parentFlow": root_flow.id,
        "parentOp": root_flow.root_op.id,
        "parentNode": root_flow.root_op.node,
        "trace": root_flow.id,
    }

    op = root_flow.start(node="tool:search", name="tool.call")
    link_from_op = root_flow.spawn_link(op)
    assert link_from_op == {
        "parentFlow": root_flow.id,
        "parentOp": op.id,
        "parentNode": "tool:search",
        "trace": root_flow.id,
    }

    # Linked but no explicit trace: only the hub can resolve it.
    child_no_trace = tracer.start_flow(link={"parentFlow": "parent-1", "parentOp": "p-op", "parentNode": "p-node"})
    grandchild_link = child_no_trace.spawn_link()
    assert "trace" not in grandchild_link
    assert grandchild_link == {
        "parentFlow": child_no_trace.id,
        "parentOp": child_no_trace.root_op.id,
        "parentNode": child_no_trace.root_op.node,
    }

    # Linked with an explicit trace: propagate it.
    child_with_trace = tracer.start_flow(link={"parentFlow": "parent-2", "trace": "root-trace-id"})
    assert child_with_trace.spawn_link()["trace"] == "root-trace-id"

    tracer.close()


def test_explicit_parent_sets_parent_op_and_node_omitted_otherwise():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000)
    flow = tracer.start_flow()
    parent_op = flow.start(node="agent:main", name="agent.step")
    child_op = flow.start(node="tool:search", name="tool.call", parent=parent_op)
    unrelated_op = flow.start(node="tool:other", name="tool.call")
    tracer.close()

    events = [e for batch in transport.batches for e in batch]
    child_start = next(e for e in events if e["op"] == child_op.id and e["type"] == "start")
    assert child_start["parentOp"] == parent_op.id
    assert child_start["parentNode"] == "agent:main"

    unrelated_start = next(e for e in events if e["op"] == unrelated_op.id and e["type"] == "start")
    assert "parentOp" not in unrelated_start
    assert "parentNode" not in unrelated_start


def test_close_flushes_remaining_events_and_is_idempotent():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000)
    flow = tracer.start_flow()
    op = flow.start(node="n", name="x")
    op.end()

    assert transport.batches == []
    tracer.close()
    flat = [e for batch in transport.batches for e in batch]
    assert len(flat) == 3  # root start + op start + op end

    tracer.close()  # idempotent
    flat_again = [e for batch in transport.batches for e in batch]
    assert len(flat_again) == 3

    # Post-close activity does not resurrect the tracer.
    late_op = flow.start(node="late", name="late.call")
    late_op.end()
    tracer.flush()
    flat_final = [e for batch in transport.batches for e in batch]
    assert len(flat_final) == 3


def test_root_start_event_shape():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000, actor={"id": "agent:saga", "kind": "agent"})
    flow = tracer.start_flow(label="Triage CVE-2026-1234")
    tracer.close()

    events = [e for batch in transport.batches for e in batch]
    root_start = next(e for e in events if e["op"] == flow.root_op.id and e["type"] == "start")
    assert root_start["root"] is True
    assert root_start["node"] == "agent:saga"
    assert root_start["name"] == "flow"
    assert root_start["kind"] == "agent"
    assert root_start["label"] == "Triage CVE-2026-1234"
    assert root_start["actor"] == {"id": "agent:saga", "kind": "agent"}


def test_flow_without_actor_defaults_root_node_to_flow():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000)
    flow = tracer.start_flow()
    tracer.close()
    events = [e for batch in transport.batches for e in batch]
    root_start = next(e for e in events if e["op"] == flow.root_op.id and e["type"] == "start")
    assert root_start["node"] == "flow"
    assert root_start["kind"] == "agent"


def test_flow_end_ends_root_op_once():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000)
    flow = tracer.start_flow()
    flow.end()
    flow.end(status="error")  # ignored: root op already ended
    tracer.close()

    events = [e for batch in transport.batches for e in batch]
    ends = [e for e in events if e["op"] == flow.root_op.id and e["type"] == "end"]
    assert len(ends) == 1
    assert ends[0]["status"] == "success"
    assert isinstance(ends[0]["durationMs"], (int, float))


def test_event_ids_are_unique_across_a_busy_tracer():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000, max_queue=10_000)
    flow = tracer.start_flow()
    for i in range(200):
        op = flow.start(node=f"tool:{i}", name="tool.call")
        op.update(context={"i": i})
        op.annotate(context={"note": "x"})
        op.end()
    tracer.close()

    ids = [e["id"] for batch in transport.batches for e in batch]
    assert len(set(ids)) == len(ids)
    assert len(ids) == 1 + 200 * 4


# ---------------------------------------------------------------------------
# `with flow.op(...) as op:` context manager
# ---------------------------------------------------------------------------


def test_op_context_manager_ends_success_on_normal_exit():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000)
    flow = tracer.start_flow()
    with flow.op(node="tool:search", name="tool.call") as op:
        assert current_op.get() is op
    assert current_op.get() is None
    tracer.close()

    events = [e for batch in transport.batches for e in batch]
    end = next(e for e in events if e["op"] == op.id and e["type"] == "end")
    assert end["status"] == "success"


def test_op_context_manager_ends_error_with_class_name_only_and_reraises():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000)
    flow = tracer.start_flow()

    class BoomError(RuntimeError):
        pass

    captured_op = {}
    with pytest.raises(BoomError):
        with flow.op(node="tool:search", name="tool.call") as op:
            captured_op["op"] = op
            raise BoomError("secret details should not leak into context")

    tracer.close()
    events = [e for batch in transport.batches for e in batch]
    end = next(e for e in events if e["op"] == captured_op["op"].id and e["type"] == "end")
    assert end["status"] == "error"
    assert end["context"] == {"error": "BoomError"}
    # No message text leaked into the stored context.
    assert "secret details" not in str(end["context"])


def test_nested_flow_start_without_parent_picks_up_current_op_from_context_manager():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000)
    flow = tracer.start_flow()

    with flow.op(node="agent:main", name="agent.step") as outer:
        inner = flow.start(node="tool:search", name="tool.call")  # no explicit parent
        inner.end()

    tracer.close()
    events = [e for batch in transport.batches for e in batch]
    inner_start = next(e for e in events if e["op"] == inner.id and e["type"] == "start")
    assert inner_start["parentOp"] == outer.id
    assert inner_start["parentNode"] == "agent:main"


# ---------------------------------------------------------------------------
# contextvars propagation across a real thread
# ---------------------------------------------------------------------------


def test_current_op_propagates_across_thread_via_copy_context():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000)
    flow = tracer.start_flow()

    results = {}

    def worker():
        # No explicit parent: should pick up the outer op via the copied context.
        child = flow.start(node="tool:from-thread", name="tool.call")
        child.end()
        results["child_id"] = child.id

    with flow.op(node="agent:main", name="agent.step") as outer:
        ctx = contextvars.copy_context()
        thread = threading.Thread(target=lambda: ctx.run(worker))
        thread.start()
        thread.join()

    tracer.close()
    events = [e for batch in transport.batches for e in batch]
    child_start = next(e for e in events if e["op"] == results["child_id"] and e["type"] == "start")
    assert child_start["parentOp"] == outer.id
    assert child_start["parentNode"] == "agent:main"


def test_current_op_does_not_leak_into_a_plain_new_thread_without_copy_context():
    transport = MemoryTransport()
    tracer = ActivityTracer(transport=transport, flush_interval_ms=1_000_000)
    flow = tracer.start_flow()

    results = {}

    def worker():
        child = flow.start(node="tool:from-thread", name="tool.call")
        child.end()
        results["child_id"] = child.id

    with flow.op(node="agent:main", name="agent.step"):
        # A plain new Thread gets a fresh context, not a copy: contextvars do
        # not propagate unless the caller explicitly copies them.
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()

    tracer.close()
    events = [e for batch in transport.batches for e in batch]
    child_start = next(e for e in events if e["op"] == results["child_id"] and e["type"] == "start")
    assert "parentOp" not in child_start
