"""Shared models and low-level HTTP helpers for price change services."""

import threading
import time
from dataclasses import dataclass
from typing import Dict, List, Optional

import requests

REQUEST_TIMEOUT = 30
BINANCE_MAX_LIMIT = 1000
YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
DAILY_SERIES_TTL_SECONDS = 6 * 60 * 60
ERROR_CACHE_TTL_SECONDS = 5 * 60
MAX_YEARLY_WORKERS = 6


class ThreadLocalSession:
    """Small thread-safe session wrapper for concurrent market-data fetches."""

    def __init__(self, trust_env: bool = True, verify: bool = True) -> None:
        self.headers: Dict[str, str] = {}
        self.trust_env = trust_env
        self.verify = verify
        self._local = threading.local()

    def _get(self) -> requests.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = requests.Session()
            session.headers.update(self.headers)
            if not self.trust_env:
                session.trust_env = False
            if not self.verify:
                session.verify = False
            self._local.session = session
        return session

    def get(self, *args, **kwargs):
        return self._get().get(*args, **kwargs)


@dataclass
class PriceSeries:
    timestamps: List[int]
    closes: List[Optional[float]]
    source: Optional[str]
    fetched_at: float
    error: Optional[str] = None
    # Optional OHLC, aligned with timestamps. Populated only by fetchers that
    # carry full candles (used for candlestick charts). closes stays the source
    # of truth for returns; for stocks closes may be adjusted while opens/highs/
    # lows are raw prices.
    opens: Optional[List[Optional[float]]] = None
    highs: Optional[List[Optional[float]]] = None
    lows: Optional[List[Optional[float]]] = None


def empty_series(source: Optional[str] = None, error: Optional[str] = None) -> PriceSeries:
    return PriceSeries([], [], source, time.time(), error)


def series_from_points(
    timestamps: List[int],
    closes: List[Optional[float]],
    source: str,
    opens: Optional[List[Optional[float]]] = None,
    highs: Optional[List[Optional[float]]] = None,
    lows: Optional[List[Optional[float]]] = None,
) -> PriceSeries:
    return PriceSeries(timestamps, closes, source, time.time(),
                       opens=opens, highs=highs, lows=lows)
