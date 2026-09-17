"""ULID (Universally Unique Lexicographically Sortable Identifier) generation.

26-character Crockford base32: a 10-character 48-bit millisecond timestamp
followed by a 16-character 80-bit random component. Calls within the same
millisecond increment the random component (monotonic factory), so ids
produced back-to-back stay lexicographically sortable and never collide
under normal use. Thread-safe. Stdlib only.

https://github.com/ulid/spec
"""

from __future__ import annotations

import os
import threading
import time

_ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_TIME_LEN = 10
_RANDOM_LEN = 16
_RANDOM_BYTES = 10  # 80 bits = 16 base32 chars exactly
_RANDOM_BITS = 80
_RANDOM_MAX = (1 << _RANDOM_BITS) - 1

_lock = threading.Lock()
_last_time = -1
_last_random = 0


def _random_bigint() -> int:
    return int.from_bytes(os.urandom(_RANDOM_BYTES), "big")


def _encode_time(time_ms: int) -> str:
    chars: list[str] = []
    t = time_ms
    for _ in range(_TIME_LEN):
        t, mod = divmod(t, 32)
        chars.append(_ENCODING[mod])
    return "".join(reversed(chars))


def _encode_random(value: int) -> str:
    chars: list[str] = []
    v = value
    for _ in range(_RANDOM_LEN):
        v, mod = divmod(v, 32)
        chars.append(_ENCODING[mod])
    return "".join(reversed(chars))


def ulid() -> str:
    """Generate a new 26-character Crockford-base32 ULID, monotonic within a millisecond."""
    global _last_time, _last_random
    with _lock:
        time_ms = int(time.time() * 1000)
        if time_ms == _last_time:
            random_value = _last_random + 1
            if random_value > _RANDOM_MAX:
                # 80 bits of randomness exhausted inside one millisecond:
                # vanishingly rare, but stay monotonic by borrowing the next ms.
                time_ms += 1
                random_value = _random_bigint()
        else:
            random_value = _random_bigint()
        _last_time = time_ms
        _last_random = random_value
        return _encode_time(time_ms) + _encode_random(random_value)
