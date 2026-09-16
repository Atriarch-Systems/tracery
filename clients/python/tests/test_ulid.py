import re
import time

from atriarch.activity import ulid

CROCKFORD = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


def test_ulid_is_26char_crockford_and_unique():
    seen = set()
    ids = []
    for _ in range(2000):
        value = ulid()
        assert CROCKFORD.match(value)
        assert value not in seen
        seen.add(value)
        ids.append(value)
    for a, b in zip(ids, ids[1:]):
        assert b >= a


def test_ulid_timestamp_prefix_reflects_wall_clock_order():
    first = ulid()
    time.sleep(0.005)
    second = ulid()
    assert second[:10] >= first[:10]
    assert second > first


def test_ulid_is_thread_safe():
    import threading

    results: list[str] = []
    lock = threading.Lock()

    def worker():
        for _ in range(200):
            value = ulid()
            with lock:
                results.append(value)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(results) == len(set(results))
