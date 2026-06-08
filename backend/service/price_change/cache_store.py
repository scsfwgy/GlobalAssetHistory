"""Tiny dependency-free Upstash Redis (REST) client with graceful fallback.

Used as a shared L2 cache across serverless instances. When no Upstash/Vercel KV
env vars are configured (e.g. local dev), every call returns None / False so
callers transparently fall back to in-memory / file-based behaviour.

Env vars (either naming scheme works):
  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (Upstash native)
  KV_REST_API_URL        / KV_REST_API_TOKEN          (Vercel KV integration)
"""

import logging
import os
import threading
from typing import List, Optional

import requests

logger = logging.getLogger(__name__)

_REST_TIMEOUT = 4  # seconds — keep short, this sits in the request path
_KEY_PREFIX = "gah:"  # GlobalAssetHistory namespace

_BASE_URL = (os.getenv("UPSTASH_REDIS_REST_URL") or os.getenv("KV_REST_API_URL") or "").rstrip("/")
_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN") or os.getenv("KV_REST_API_TOKEN") or ""

_local = threading.local()


def is_enabled() -> bool:
    return bool(_BASE_URL and _TOKEN)


def _session() -> requests.Session:
    s = getattr(_local, "session", None)
    if s is None:
        s = requests.Session()
        s.headers.update({"Authorization": f"Bearer {_TOKEN}"})
        _local.session = s
    return s


def _command(args: List[str]):
    """Run one Redis command via the Upstash REST endpoint. Returns the raw
    `result` value, or None on any failure (network, auth, redis error)."""
    if not is_enabled():
        return None
    try:
        resp = _session().post(_BASE_URL, json=args, timeout=_REST_TIMEOUT)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as e:  # noqa: BLE001 — never let cache layer break a request
        logger.warning("Upstash command %s failed: %s", args[0], e)
        return None
    if isinstance(payload, dict) and payload.get("error"):
        logger.warning("Upstash command %s error: %s", args[0], payload["error"])
        return None
    return payload.get("result") if isinstance(payload, dict) else None


def cache_get(key: str) -> Optional[str]:
    result = _command(["GET", _KEY_PREFIX + key])
    return result if isinstance(result, str) else None


def cache_set(key: str, value: str, ttl_seconds: int) -> bool:
    result = _command(["SET", _KEY_PREFIX + key, value, "EX", str(int(ttl_seconds))])
    return result == "OK"


def cache_incr(key: str) -> Optional[int]:
    result = _command(["INCR", _KEY_PREFIX + key])
    try:
        return int(result) if result is not None else None
    except (TypeError, ValueError):
        return None


def cache_del(key: str) -> bool:
    result = _command(["DEL", _KEY_PREFIX + key])
    return isinstance(result, int) and result > 0


def cache_expire(key: str, ttl_seconds: int) -> bool:
    result = _command(["EXPIRE", _KEY_PREFIX + key, str(int(ttl_seconds))])
    return result == 1


def cache_lpush(key: str, value: str) -> Optional[int]:
    result = _command(["LPUSH", _KEY_PREFIX + key, value])
    try:
        return int(result) if result is not None else None
    except (TypeError, ValueError):
        return None


def cache_lrange(key: str, start: int, stop: int) -> List[str]:
    result = _command(["LRANGE", _KEY_PREFIX + key, str(int(start)), str(int(stop))])
    return [v for v in result if isinstance(v, str)] if isinstance(result, list) else []


def cache_ltrim(key: str, start: int, stop: int) -> bool:
    result = _command(["LTRIM", _KEY_PREFIX + key, str(int(start)), str(int(stop))])
    return result == "OK"


def cache_lrem(key: str, count: int, value: str) -> Optional[int]:
    result = _command(["LREM", _KEY_PREFIX + key, str(int(count)), value])
    try:
        return int(result) if result is not None else None
    except (TypeError, ValueError):
        return None
