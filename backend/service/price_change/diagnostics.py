"""Live reachability probes for the upstream market-data sources.

Each probe makes ONE lightweight request with a short timeout and never raises —
it returns a structured status dict instead. Probes run concurrently so the
whole diagnostic stays well under the serverless function budget. Results are
memoised briefly so the endpoint can't be used to hammer the upstreams.

This is read-only and side-effect-free (other than the outbound probe requests),
intended for an operator to see, at a glance, which data source is actually
working from the deployed environment (e.g. Binance geo-blocked on cloud IPs).
"""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Dict, List

import requests

from . import cache_store
from .common import YAHOO_BASE
from .config import binance_base_url, coingecko_base_url, okx_base_url

logger = logging.getLogger(__name__)

_PROBE_TIMEOUT = 6  # seconds — short so a hung source can't eat the budget
_MEMO_TTL = 20  # seconds — throttle repeated calls
_HEADERS = {"User-Agent": "Mozilla/5.0"}

_memo_lock = threading.Lock()
_memo: Dict[str, object] = {"at": 0.0, "data": None}


def _probe(name: str, asset: str, fn: Callable[[], Dict]) -> Dict:
    """Run one probe, timing it and trapping every error."""
    start = time.time()
    result = {"name": name, "asset": asset, "ok": False}
    try:
        detail = fn()
        result.update(detail)
    except requests.exceptions.Timeout:
        result["error"] = f"timeout >{_PROBE_TIMEOUT}s"
    except Exception as e:  # noqa: BLE001 — a probe must never raise
        result["error"] = str(e)
    result["latency_ms"] = int((time.time() - start) * 1000)
    return result


def _probe_yahoo() -> Dict:
    resp = requests.get(
        f"{YAHOO_BASE}/AAPL",
        params={"range": "5d", "interval": "1d"},
        headers=_HEADERS,
        timeout=_PROBE_TIMEOUT,
    )
    ok = resp.status_code == 200 and "chart" in (resp.json() or {})
    out = {"ok": ok, "status": resp.status_code}
    if resp.status_code == 429:
        out["error"] = "rate-limited (429) — common on cloud IPs"
    return out


def _probe_binance() -> Dict:
    resp = requests.get(
        f"{binance_base_url()}/api/v3/ping",
        headers=_HEADERS,
        timeout=_PROBE_TIMEOUT,
    )
    out = {"ok": resp.status_code == 200, "status": resp.status_code}
    if resp.status_code in (451, 403):
        out["error"] = "geo-blocked (likely) — cloud IP restricted"
    return out


def _probe_okx() -> Dict:
    resp = requests.get(
        f"{okx_base_url()}/api/v5/public/time",
        headers=_HEADERS,
        timeout=_PROBE_TIMEOUT,
    )
    ok = resp.status_code == 200 and (resp.json() or {}).get("code") == "0"
    return {"ok": ok, "status": resp.status_code}


def _probe_coingecko() -> Dict:
    resp = requests.get(
        f"{coingecko_base_url()}/ping",
        headers=_HEADERS,
        timeout=_PROBE_TIMEOUT,
    )
    out = {"ok": resp.status_code == 200, "status": resp.status_code}
    if resp.status_code == 429:
        out["error"] = "rate-limited (429) — free tier throttle"
    return out


def _probe_east_money() -> Dict:
    # No dedicated health endpoint; ask for a tiny slice of the SSE Composite.
    resp = requests.get(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get",
        params={
            "ut": "fa5fd1943c7b386f172d6893dbfd32bb",
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "klt": "101",
            "fqt": "1",
            "secid": "1.000001",
            "lmt": "1",
            "end": "20500101",
        },
        headers=_HEADERS,
        timeout=_PROBE_TIMEOUT,
    )
    klines = (resp.json() or {}).get("data", {}).get("klines", []) if resp.status_code == 200 else []
    return {"ok": bool(klines), "status": resp.status_code}


_PROBES: List = [
    ("yahoo", "stock", _probe_yahoo),
    ("binance", "crypto", _probe_binance),
    ("okx", "crypto", _probe_okx),
    ("coingecko", "crypto", _probe_coingecko),
    ("eastmoney", "cn_stock", _probe_east_money),
]


def _collect() -> Dict:
    # Redis: round-trip PING so we report real reachability, not just config.
    redis_enabled = cache_store.is_enabled()
    redis = {"configured": redis_enabled, "reachable": cache_store.ping() if redis_enabled else False}

    sources: List[Dict] = []
    with ThreadPoolExecutor(max_workers=len(_PROBES)) as executor:
        futures = {executor.submit(_probe, n, a, fn): n for (n, a, fn) in _PROBES}
        for fut in as_completed(futures):
            sources.append(fut.result())
    sources.sort(key=lambda s: (s["asset"], s["name"]))

    # Per-asset verdict: a class is "up" if any of its sources is reachable.
    by_asset: Dict[str, bool] = {}
    for s in sources:
        by_asset[s["asset"]] = by_asset.get(s["asset"], False) or s["ok"]

    return {
        "checked_at": int(time.time()),
        "redis": redis,
        "asset_ok": by_asset,
        "sources": sources,
    }


def run_diagnostics(fresh: bool = False) -> Dict:
    """Probe all sources, memoised for _MEMO_TTL seconds unless fresh=True."""
    now = time.time()
    if not fresh:
        with _memo_lock:
            if _memo["data"] is not None and now - float(_memo["at"]) < _MEMO_TTL:
                cached = dict(_memo["data"])  # shallow copy; mark as cached
                cached["cached"] = True
                return cached

    data = _collect()
    data["cached"] = False
    with _memo_lock:
        _memo["at"] = now
        _memo["data"] = data
    return data
