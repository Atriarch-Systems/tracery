import http.server
import json
import threading
import time
import urllib.error
import urllib.request

from atriarch.tracery import HttpTransport, MemoryTransport

SAMPLE_EVENTS = [
    {"v": 1, "id": "e1", "ts": 1000, "flow": "f1", "op": "o1", "node": "n1", "type": "start", "name": "x", "root": True}
]


def start_fake_hub(responder):
    """responder(record, request_number) -> (status, json_body)"""
    requests: list[dict] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):  # noqa: A002 - stdlib signature
            pass

        def do_POST(self):
            length = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(length) if length else b""
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = None
            # Normalize header casing: urllib.request.Request title-cases the
            # headers it sends (e.g. "Authorization"), so compare lowercase.
            headers = {k.lower(): v for k, v in self.headers.items()}
            record = {"method": "POST", "path": self.path, "headers": headers, "body": parsed}
            requests.append(record)
            status, payload = responder(record, len(requests))
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    return server, thread, base_url, requests


def stop_fake_hub(server, thread):
    server.shutdown()
    thread.join(timeout=5)
    server.server_close()


def test_http_transport_posts_with_auth_and_workspace_then_retries_5xx_until_success():
    def responder(record, n):
        if n < 3:
            return 503, {"error": {"code": "busy", "message": "retry me"}}
        return 200, {"accepted": 1, "duplicates": 0, "rejected": [], "cursor": 7}

    server, thread, base_url, requests = start_fake_hub(responder)
    try:
        transport = HttpTransport(base_url=base_url, api_key="secret-key", workspace="default", retries=5, backoff_ms=5)
        transport.send(SAMPLE_EVENTS)
        transport.flush()

        assert len(requests) == 3
        for req in requests:
            assert req["method"] == "POST"
            assert req["path"] == "/v1/events"
            assert req["headers"]["authorization"] == "Bearer secret-key"
            assert req["headers"]["content-type"] == "application/json"
            assert req["body"]["v"] == 1
            assert req["body"]["workspace"] == "default"
            assert req["body"]["events"] == SAMPLE_EVENTS
        transport.close()
    finally:
        stop_fake_hub(server, thread)


def test_http_transport_gives_up_after_exhausting_retries_without_raising():
    def responder(record, n):
        return 500, {"error": {"code": "down", "message": "nope"}}

    server, thread, base_url, requests = start_fake_hub(responder)
    try:
        transport = HttpTransport(base_url=base_url, api_key="k", retries=2, backoff_ms=5)
        transport.send(SAMPLE_EVENTS)
        transport.flush()  # must not raise
        assert len(requests) == 3  # 1 initial + 2 retries
        transport.close()
    finally:
        stop_fake_hub(server, thread)


def test_http_transport_does_not_retry_4xx():
    def responder(record, n):
        return 400, {"error": {"code": "bad", "message": "no"}}

    server, thread, base_url, requests = start_fake_hub(responder)
    try:
        transport = HttpTransport(base_url=base_url, api_key="k", retries=5, backoff_ms=5)
        transport.send(SAMPLE_EVENTS)
        transport.flush()
        assert len(requests) == 1
        transport.close()
    finally:
        stop_fake_hub(server, thread)


def test_http_transport_retries_a_network_error_via_injected_opener():
    def responder(record, n):
        return 200, {"accepted": 1, "duplicates": 0, "rejected": [], "cursor": 1}

    server, thread, base_url, requests = start_fake_hub(responder)
    calls = {"n": 0}

    def flaky_opener(request, timeout=None):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise urllib.error.URLError("simulated network failure")
        return urllib.request.urlopen(request, timeout=timeout)

    try:
        transport = HttpTransport(base_url=base_url, api_key="k", retries=5, backoff_ms=5, opener=flaky_opener)
        transport.send(SAMPLE_EVENTS)
        transport.flush()
        assert calls["n"] == 3
        assert len(requests) == 1  # only the 3rd attempt ever reached the server
        transport.close()
    finally:
        stop_fake_hub(server, thread)


def test_http_transport_drops_and_counts_when_delivery_queue_is_full():
    def responder(record, n):
        if n == 1:
            time.sleep(0.3)  # keep the worker thread busy in-flight
        return 200, {"accepted": 1, "duplicates": 0, "rejected": [], "cursor": n}

    server, thread, base_url, requests = start_fake_hub(responder)
    try:
        transport = HttpTransport(base_url=base_url, api_key="k", max_queue=1, retries=0)
        transport.send(SAMPLE_EVENTS)  # dequeued almost immediately; blocks the worker for 0.3s
        time.sleep(0.05)  # let the worker actually dequeue item 1
        transport.send(SAMPLE_EVENTS)  # queued (the one free slot)
        transport.send(SAMPLE_EVENTS)  # dropped: queue full
        transport.send(SAMPLE_EVENTS)  # dropped: queue full

        assert transport.dropped == len(SAMPLE_EVENTS) * 2
        transport.close()
        assert len(requests) == 2  # only items 1 and 2 ever reached the hub
    finally:
        stop_fake_hub(server, thread)


def test_memory_transport_records_every_batch_verbatim_in_order():
    transport = MemoryTransport()
    transport.send(SAMPLE_EVENTS)
    transport.send([])
    transport.send(SAMPLE_EVENTS)
    assert len(transport.batches) == 3
    assert transport.batches[0] == SAMPLE_EVENTS
    assert transport.batches[1] == []
