# atriarch-tracery

Python emitter SDK for [Tracery](../../docs/SPEC.md) (module
`atriarch.tracery`): batches `start`/`update`/`end`/`annotate` events for a
flow and its ops and ships them to a hub, stdlib only. See `docs/SPEC.md` §5
for the full contract this implements, and `../../packages/client` for the
TypeScript sibling.

## Install

```
pip install atriarch-tracery
```

Requires Python >=3.11. `atriarch` is a PEP 420 namespace package (there is
no `atriarch/__init__.py`), so this can be installed alongside other
`atriarch.*` distributions without conflict.

## Quick start: a parent flow spawning a subagent flow

```python
import os
from atriarch.tracery import ActivityTracer, HttpTransport

tracer = ActivityTracer(
    transport=HttpTransport(base_url="https://tracery.example.com", api_key=os.environ["TRACERY_API_KEY"]),
    actor={"id": "agent:saga", "kind": "agent"},
)

# Parent flow.
flow = tracer.start_flow(label="Triage CVE-2026-1234")

with flow.op(node="llm:main", name="llm.provider", kind="llm") as op:
    op.update(context={"tokens": 120})
    op.annotate(context={"note": "retrying after a rate limit"})
    # op.end() is called automatically on exit: 'success', or 'error' with
    # context={"error": exc.__class__.__name__} if the block raises.

# Hand a subagent the link it needs to attach its own flow to this one.
link = flow.spawn_link(op)
spawn_subagent(link)  # however you launch the subagent process/task

flow.end()
tracer.close()
```

The subagent process constructs its own tracer and starts its flow with the
link it was handed:

```python
import os
from atriarch.tracery import ActivityTracer, HttpTransport

# `link` is whatever spawn_subagent above passed through (env var, IPC message, etc).
sub_tracer = ActivityTracer(
    transport=HttpTransport(base_url="https://tracery.example.com", api_key=os.environ["TRACERY_API_KEY"]),
    actor={"id": "agent:saga/subagent:research-7", "kind": "subagent"},
)

sub_flow = sub_tracer.start_flow(label="Research CVE-2026-1234", link=link)
with sub_flow.op(node="tool:search", name="tool.call", kind="tool"):
    pass  # do the work; ends 'success' on exit

sub_flow.end()
sub_tracer.close()
```

The hub (or `project()` in `@atriarch/tracery-core`) resolves the two flows
into one trace, with a `spawn` edge from the parent's `llm:main` op to the
subagent's root node.

## API

- `ulid()` — a 26-character Crockford-base32 ULID, monotonic within a
  millisecond, thread-safe. No dependency.
- `ActivityTracer(transport, actor=None, flush_interval_ms=250, max_batch=500, max_queue=10000, clock=None)`
  — owns the event queue and a background flush timer. `.dropped` counts
  events dropped because the queue exceeded `max_queue`. `.flush()` drains
  the queue now; `.close()` flushes, stops the timer, and closes the
  transport.
- `tracer.start_flow(id=None, label=None, link=None, context=None, actor=None)`
  — starts a flow and its root op (`root=True`, `node` defaults to
  `actor["id"]` or `"flow"`, `name="flow"`, `kind` defaults to
  `actor["kind"]` or `"agent"`). Returns a `Flow`.
- `flow.start(node, name, kind=None, label=None, parent=None, relation=None, data_from=None, context=None, tags=None)`
  — starts a non-root op. If `parent` is omitted, the *current* op (see
  contextvars below) is used automatically when it belongs to this flow.
  Returns an `Op` with `.update()`, `.annotate()`, and
  `.end(status=None, context=None, duration_ms=None)` (`duration_ms` is
  computed from the clock's monotonic reading unless given; `status`
  defaults to `"success"`).
- `with flow.op(node=..., name=...) as op:` — a context manager: starts the
  op, makes it (and the flow) "current" for the block via `contextvars` (so
  nested `flow.start(...)` calls inside pick it up as an implicit parent),
  and ends it on exit — `success` normally, or `error` with
  `context={"error": exc.__class__.__name__}` (the exception's class name
  only, never its message) if the block raised. The exception always
  re-raises.
- `current_flow` / `current_op` — the `contextvars.ContextVar`s that carry
  "what's running right now" on this thread/task. Hand a background thread
  the right call-context parent with `contextvars.copy_context()`:
  ```python
  ctx = contextvars.copy_context()
  threading.Thread(target=lambda: ctx.run(worker)).start()
  ```
  A plain `threading.Thread` with no copied context starts fresh — `flow.start`
  inside it will not have an implicit parent.
- `flow.spawn_link(op=None)` — returns the `ActivityLink` dict a subagent
  flow needs to attach to this one (`{"parentFlow", "parentOp", "parentNode", "trace"?}`).
  Defaults to spawning from the flow's root op. `"trace"` is included when
  this flow can resolve its own trace id client-side (no link of its own, or
  an explicit `link["trace"]`); otherwise it's left for the hub.
- `flow.end(status=None, context=None)` — ends the flow's root op.

### Transports

- `HttpTransport(base_url, api_key, workspace=None, retries=5, backoff_ms=200, max_queue=10000)`
  — a daemon background thread drains its own bounded `queue.Queue` and
  POSTs batches to `{base_url}/v1/events` with `Authorization: Bearer` via
  `urllib.request`. `send()` only enqueues and returns immediately — it
  never blocks the caller on the actual HTTP call, and never raises.
  Retries network errors and 5xx with exponential backoff; 4xx is dropped,
  not retried. `.dropped` counts events dropped because its own delivery
  queue was full.
- `MemoryTransport()` — records every batch on `.batches`; for tests.

## Development

```
python -m pip install -e "clients/python[dev]"
python -m pytest -q clients/python
```
