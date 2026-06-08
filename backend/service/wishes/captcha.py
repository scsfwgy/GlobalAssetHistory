"""Dependency-free SVG image CAPTCHA with one-time verification.

Answers are stored in the shared cache (Upstash Redis) when configured, so a
CAPTCHA issued by one serverless instance can be verified by another. When no
Redis is configured (local dev), answers live in a process-local dict with the
same TTL semantics.

The image is hand-rolled SVG (no Pillow / image libs) to match the project's
native-SVG style and keep the dependency footprint at zero.
"""

import logging
import random
import threading
import time
from html import escape
from typing import Dict, Tuple
from uuid import uuid4

from service.price_change import cache_store

logger = logging.getLogger(__name__)

_TTL_SECONDS = 300
_KEY_PREFIX = "wish_captcha:"
_LENGTH = 4
# Drop visually ambiguous glyphs (0/O, 1/I/l) so users do not misread them.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_COLORS = ["#0071e3", "#34c759", "#ff9f0a", "#ff453a", "#bf5af2", "#5ac8fa"]

_WIDTH = 120
_HEIGHT = 44

# Process-local fallback store: {captcha_id: (answer_lower, expire_ts)}.
_local_store: Dict[str, Tuple[str, float]] = {}
_local_lock = threading.Lock()


def _purge_expired(now: float) -> None:
    expired = [cid for cid, (_, exp) in _local_store.items() if exp <= now]
    for cid in expired:
        _local_store.pop(cid, None)


def _store_answer(captcha_id: str, answer: str) -> None:
    if cache_store.is_enabled():
        if cache_store.cache_set(_KEY_PREFIX + captcha_id, answer, _TTL_SECONDS):
            return
        # Redis transiently unavailable — fall through to the local store.
    now = time.time()
    with _local_lock:
        _purge_expired(now)
        _local_store[captcha_id] = (answer, now + _TTL_SECONDS)


def _pop_answer(captcha_id: str):
    """Fetch and consume the stored answer (one-time use). Returns None if
    missing/expired."""
    if cache_store.is_enabled():
        answer = cache_store.cache_get(_KEY_PREFIX + captcha_id)
        if answer is not None:
            cache_store.cache_del(_KEY_PREFIX + captcha_id)
            return answer
        # Not in Redis — it may have been issued before Redis came up, or stored
        # locally. Fall through and also check the local store.
    now = time.time()
    with _local_lock:
        _purge_expired(now)
        entry = _local_store.pop(captcha_id, None)
    if entry is None:
        return None
    answer, expire_ts = entry
    return answer if expire_ts > now else None


def _render_svg(code: str) -> str:
    """Render the code as a noisy, distorted SVG string."""
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_WIDTH}" height="{_HEIGHT}" '
        f'viewBox="0 0 {_WIDTH} {_HEIGHT}" role="img" aria-label="captcha">',
        f'<rect width="{_WIDTH}" height="{_HEIGHT}" fill="#1c1c1e" rx="8"/>',
    ]
    # Noise lines behind the text.
    for _ in range(5):
        x1, y1 = random.randint(0, _WIDTH), random.randint(0, _HEIGHT)
        x2, y2 = random.randint(0, _WIDTH), random.randint(0, _HEIGHT)
        color = random.choice(_COLORS)
        parts.append(
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
            f'stroke="{color}" stroke-width="1" opacity="0.35"/>'
        )
    # One <text> per char with random rotation / size / color.
    slot = _WIDTH / (len(code) + 1)
    for i, ch in enumerate(code):
        x = slot * (i + 1)
        y = _HEIGHT / 2 + random.randint(-3, 3)
        rotate = random.randint(-25, 25)
        size = random.randint(22, 28)
        color = random.choice(_COLORS)
        parts.append(
            f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" '
            f'font-family="Helvetica, Arial, sans-serif" font-weight="700" '
            f'fill="{color}" text-anchor="middle" dominant-baseline="middle" '
            f'transform="rotate({rotate} {x:.1f} {y:.1f})">{escape(ch)}</text>'
        )
    parts.append("</svg>")
    return "".join(parts)


def generate() -> Tuple[str, str]:
    """Issue a new CAPTCHA. Returns (captcha_id, svg_string)."""
    code = "".join(random.choice(_ALPHABET) for _ in range(_LENGTH))
    captcha_id = uuid4().hex
    _store_answer(captcha_id, code.lower())
    return captcha_id, _render_svg(code)


def verify(captcha_id: str, answer: str) -> bool:
    """One-time, case-insensitive verification. Consumes the answer on any
    lookup so a CAPTCHA can never be replayed."""
    if not captcha_id or not answer:
        return False
    stored = _pop_answer(captcha_id)
    if stored is None:
        return False
    return stored.strip().lower() == answer.strip().lower()
