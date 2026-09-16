"""Transports an ``ActivityTracer`` can flush batches into.

``HttpTransport`` is deliberately decoupled from the tracer's own flush
cycle: ``send()`` only enqueues onto an internal, bounded ``queue.Queue``
and returns immediately; a dedicated daemon thread drains that queue and
performs the actual (blocking, stdlib-only ``urllib.request``) HTTP POST
with retry/backoff at its own pace. That keeps a slow or failing hub from
ever blocking the caller of ``send()`` -- including the tracer's own flush
timer thread.
"""

from __future__ import annotations

import json
import queue
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from .events import ACTIVITY_CONTRACT_VERSION


class MemoryTransport:
    """Records every batch in memory instead of sending it anywhere. For tests."""

    def __init__(self) -> None:
        self.batches: list[list[dict[str, Any]]] = []

    def send(self, events: list[dict[str, Any]]) -> None:
        self.batches.append(list(events))

    def flush(self) -> None:
        return None

    def close(self) -> None:
        return None


_SHUTDOWN = object()


class HttpTransport:
    """Posts ``ActivityBatch``es to ``{base_url}/v1/events``.

    Never blocks or raises into the producer: ``send()`` enqueues onto a
    bounded ``queue.Queue`` (dropping, and counting on ``.dropped``, when
    full) and a background daemon thread does the actual delivery. Retries
    network errors and 5xx responses with exponential backoff; 4xx
    responses are not retryable and are dropped.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        workspace: str | None = None,
        retries: int = 5,
        backoff_ms: float = 200,
        max_queue: int = 10000,
        timeout_s: float = 10.0,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self._url = base_url.rstrip("/") + "/v1/events"
        self._api_key = api_key
        self._workspace = workspace
        self._retries = retries
        self._backoff_s = backoff_ms / 1000.0
        self._timeout_s = timeout_s
        # Primarily a testing seam: lets tests inject a fake opener to
        # simulate a transient network error without racing real sockets.
        self._urlopen = opener or urllib.request.urlopen

        self._queue: "queue.Queue[list[dict[str, Any]] | object]" = queue.Queue(maxsize=max_queue)
        self._dropped_lock = threading.Lock()
        self._dropped = 0
        self._closed = False

        self._thread = threading.Thread(target=self._run, name="atriarch-activity-http-transport", daemon=True)
        self._thread.start()

    @property
    def dropped(self) -> int:
        """Events dropped locally because the delivery queue was full."""
        with self._dropped_lock:
            return self._dropped

    def send(self, events: list[dict[str, Any]]) -> None:
        if self._closed or not events:
            return
        try:
            self._queue.put_nowait(list(events))
        except queue.Full:
            with self._dropped_lock:
                self._dropped += len(events)

    def flush(self) -> None:
        """Block until every batch enqueued so far has been attempted."""
        self._queue.join()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.flush()
        self._queue.put(_SHUTDOWN)
        self._thread.join(timeout=5)

    # -- background thread ---------------------------------------------------

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is _SHUTDOWN:
                self._queue.task_done()
                break
            try:
                self._send_with_retry(item)  # type: ignore[arg-type]
            except Exception:
                # A misbehaving retry path must never kill the delivery thread.
                pass
            finally:
                self._queue.task_done()

    def _build_body(self, events: list[dict[str, Any]]) -> bytes:
        batch: dict[str, Any] = {"v": ACTIVITY_CONTRACT_VERSION, "events": events}
        if self._workspace is not None:
            batch["workspace"] = self._workspace
        return json.dumps(batch).encode("utf-8")

    def _send_with_retry(self, events: list[dict[str, Any]]) -> None:
        body = self._build_body(events)
        for attempt in range(self._retries + 1):
            try:
                request = urllib.request.Request(
                    self._url,
                    data=body,
                    method="POST",
                    headers={
                        "content-type": "application/json",
                        "authorization": f"Bearer {self._api_key}",
                    },
                )
                with self._urlopen(request, timeout=self._timeout_s):
                    return  # 2xx (or a redirect urllib already followed)
            except urllib.error.HTTPError as exc:
                if exc.code < 500:
                    return  # 4xx: not retryable, drop
                # 5xx: fall through to retry
            except Exception:
                pass  # network error: fall through to retry
            if attempt < self._retries:
                time.sleep(self._backoff_s * (2**attempt))
        # Retries exhausted; drop silently rather than raise into the caller.
