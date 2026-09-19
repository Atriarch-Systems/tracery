#!/usr/bin/env python3
"""One "child flow spawned via the Python client" leg of scripts/demo.mjs
(SPEC.md §8 acceptance 4). Invoked as:

    python scripts/demo_child.py '<ActivityLink JSON>'

`TRACERY_HUB_URL` / `TRACERY_API_KEY` come from the environment (demo.mjs
sets both when it spawns this process). `TRACERY_API_KEY` is optional (task:
"local mode" -- a hub running with no TRACERY_API_KEYS needs no key at all).
Starts a flow attached to the given link, does one op, ends the flow, and
blocks (via `tracer.close()`) until the batch has been attempted -- so by
the time this process exits 0, the parent script can rely on the event
having reached the hub.
"""

from __future__ import annotations

import json
import os
import sys

from atriarch.tracery import ActivityTracer, HttpTransport


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: demo_child.py <ActivityLink JSON>", file=sys.stderr)
        return 1

    link = json.loads(sys.argv[1])
    hub_url = os.environ.get("TRACERY_HUB_URL", "http://127.0.0.1:8971")
    api_key = os.environ.get("TRACERY_API_KEY") or None

    tracer = ActivityTracer(
        transport=HttpTransport(base_url=hub_url, api_key=api_key),
        actor={"id": "agent:demo-child-py", "kind": "subagent"},
    )
    try:
        flow = tracer.start_flow(label="demo: python child", link=link)
        with flow.op(node="tool:work", name="tool.work", kind="tool", context={"lang": "python"}, parent=flow.root_op):
            pass  # do the "work"; the op ends success on exit
        flow.end()
    finally:
        tracer.close()  # flush + block until the batch has been attempted

    print(json.dumps({"flow": flow.id}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
