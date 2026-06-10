"""Wish wall storage, rate limiting, and admin moderation.

Wishes are stored in a shared Redis LIST (newest first) when Upstash/Vercel KV
is configured, so they survive serverless cold starts and are shared across
instances. Without Redis (local dev), they fall back to a local JSON file with
the same newest-first ordering. Either way the list is capped at MAX_WISHES.
"""

import json
import hmac
import logging
import os
import threading
import time
from pathlib import Path
from typing import List, Optional
from uuid import uuid4

from service.price_change import cache_store

logger = logging.getLogger(__name__)

MAX_TEXT = 200
MAX_NICK = 24
MAX_WISHES = 500
RATE_MAX = 5
RATE_WINDOW = 600  # seconds

_WISHES_KEY = "wishes"
_RATE_PREFIX = "wish_rate:"

# Local file fallback (used only when Redis is unconfigured). On serverless
# (Vercel/Lambda) the only writable dir is /tmp, but it is ephemeral — real
# persistence there comes from Redis. Locally, persist inside the project so
# wishes survive server restarts.
_IS_SERVERLESS = bool(os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME"))
_WISHES_PATH = Path("/tmp/wishes.json") if _IS_SERVERLESS else \
    Path(__file__).resolve().parent.parent.parent / "config" / "wishes.json"
_file_lock = threading.Lock()

# Process-local rate-limit fallback (used only when Redis is unconfigured).
_rate_store = {}
_rate_lock = threading.Lock()

def _clean_text(raw: str) -> str:
    """Strip control chars (except newline/tab) and surrounding whitespace."""
    if not isinstance(raw, str):
        return ""
    cleaned = "".join(
        ch for ch in raw if ch in ("\n", "\t") or (ord(ch) >= 32 and ch != "\x7f")
    )
    return cleaned.strip()


def _read_file_wishes() -> List[dict]:
    try:
        if _WISHES_PATH.exists():
            data = json.loads(_WISHES_PATH.read_text())
            if isinstance(data, list):
                return data
    except Exception:  # noqa: BLE001 — never let a bad file break the endpoint
        logger.warning("Failed to read wishes file %s", _WISHES_PATH, exc_info=True)
    return []


def _write_file_wishes(wishes: List[dict]) -> None:
    _WISHES_PATH.parent.mkdir(parents=True, exist_ok=True)
    _WISHES_PATH.write_text(json.dumps(wishes[:MAX_WISHES], ensure_ascii=False))


def list_wishes() -> List[dict]:
    """Return wishes newest-first."""
    if cache_store.is_enabled():
        raw_items = cache_store.cache_lrange(_WISHES_KEY, 0, MAX_WISHES - 1)
        wishes = []
        for raw in raw_items:
            try:
                wishes.append(json.loads(raw))
            except (ValueError, TypeError):
                continue
        return wishes
    with _file_lock:
        return _read_file_wishes()
def add_wish(text: str, nick: Optional[str], ip: Optional[str]) -> dict:
    """Validate, clean, and store a wish. Raises ValueError on bad input."""
    text = _clean_text(text)
    if not text:
        raise ValueError("心愿内容不能为空")
    if len(text) > MAX_TEXT:
        raise ValueError(f"心愿内容不能超过 {MAX_TEXT} 字")

    nick = _clean_text(nick or "")[:MAX_NICK] or None

    wish = {
        "id": uuid4().hex,
        "text": text,
        "nick": nick,
        "ts": int(time.time()),
    }

    if cache_store.is_enabled():
        raw = json.dumps(wish, ensure_ascii=False)
        if cache_store.cache_lpush(_WISHES_KEY, raw) is not None:
            cache_store.cache_ltrim(_WISHES_KEY, 0, MAX_WISHES - 1)
            return wish
        # Redis transiently unavailable — fall through to the file store.
    with _file_lock:
        wishes = _read_file_wishes()
        wishes.insert(0, wish)
        _write_file_wishes(wishes)
    return wish


def verify_admin_token(token: Optional[str]) -> bool:
    """Constant-time check of an admin token against WISH_ADMIN_TOKEN.
    Returns False if the env var is unset (fail-closed) or the token is wrong."""
    admin_token = os.getenv("WISH_ADMIN_TOKEN")
    if not admin_token or not token:
        return False
    return hmac.compare_digest(token, admin_token)


def delete_wish(wish_id: str, token: Optional[str]) -> bool:
    """Admin-only delete. Raises PermissionError if the token is missing/wrong.
    Returns True if a wish was removed, False if no matching id was found."""
    if not verify_admin_token(token):
        raise PermissionError("无权限删除")

    if cache_store.is_enabled():
        raw_items = cache_store.cache_lrange(_WISHES_KEY, 0, MAX_WISHES - 1)
        for raw in raw_items:
            try:
                if json.loads(raw).get("id") == wish_id:
                    removed = cache_store.cache_lrem(_WISHES_KEY, 1, raw)
                    return bool(removed)
            except (ValueError, TypeError):
                continue
        return False
    with _file_lock:
        wishes = _read_file_wishes()
        kept = [w for w in wishes if w.get("id") != wish_id]
        if len(kept) == len(wishes):
            return False
        _write_file_wishes(kept)
    return True


def reply_wish(wish_id: str, reply_text: str, token: Optional[str]) -> Optional[dict]:
    """Admin-only reply/update. Raises PermissionError if token is invalid."""
    if not verify_admin_token(token):
        raise PermissionError("无权限回复")

    reply = _clean_text(reply_text)
    if not reply:
        raise ValueError("回复内容不能为空")
    if len(reply) > MAX_TEXT:
        raise ValueError(f"回复内容不能超过 {MAX_TEXT} 字")

    if cache_store.is_enabled():
        raw_items = cache_store.cache_lrange(_WISHES_KEY, 0, MAX_WISHES - 1)
        for raw in raw_items:
            try:
                wish = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if wish.get("id") != wish_id:
                continue
            wish["reply"] = reply
            wish["reply_ts"] = int(time.time())
            removed = cache_store.cache_lrem(_WISHES_KEY, 1, raw)
            if removed:
                cache_store.cache_lpush(_WISHES_KEY, json.dumps(wish, ensure_ascii=False))
                cache_store.cache_ltrim(_WISHES_KEY, 0, MAX_WISHES - 1)
            return wish
        return None

    with _file_lock:
        wishes = _read_file_wishes()
        for wish in wishes:
            if wish.get("id") != wish_id:
                continue
            wish["reply"] = reply
            wish["reply_ts"] = int(time.time())
            _write_file_wishes(wishes)
            return wish
    return None


def check_rate_limit(ip: Optional[str]) -> bool:
    """Return True if this IP is allowed to post, False if over the limit.
    Counts posts per IP within a rolling window."""
    key = ip or "unknown"
    if cache_store.is_enabled():
        count = cache_store.cache_incr(_RATE_PREFIX + key)
        if count is None:
            return True  # cache hiccup — fail open rather than block users
        if count == 1:
            cache_store.cache_expire(_RATE_PREFIX + key, RATE_WINDOW)
        return count <= RATE_MAX
    now = time.time()
    with _rate_lock:
        hits = [t for t in _rate_store.get(key, []) if now - t < RATE_WINDOW]
        if len(hits) >= RATE_MAX:
            _rate_store[key] = hits
            return False
        hits.append(now)
        _rate_store[key] = hits
    return True
