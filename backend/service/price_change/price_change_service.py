"""Public API and orchestration for the price change feature."""

import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional, Tuple

from .calculations import (
    _build_equity_curve,
    _compute_daily_returns_for_month,
    _compute_monthly_returns,
    _compute_yearly_returns,
    _generate_schedule_dates,
    _normalize_frequency,
    _parse_iso_date,
    _resolve_execution_points,
    _safe_int,
    _series_points_in_range,
)
from .crash_stats import compute_crash_statistics
# NOTE: leader_breakout depends on akshare/pandas (heavy, excluded from the
# Vercel deployment). Import it lazily inside the endpoint functions so the
# rest of the app loads without those packages installed.
from .common import (
    DAILY_SERIES_TTL_SECONDS,
    ERROR_CACHE_TTL_SECONDS,
    MAX_YEARLY_WORKERS,
    PriceSeries,
    empty_series,
)
from .config import get_color_range, get_presets
from .fetchers import DAILY_SERIES_FETCHERS, FETCHERS
from . import cache_store

logger = logging.getLogger(__name__)

# L1: in-process cache (fast, but per-instance — wiped on serverless cold start).
# L2: shared Upstash Redis (cross-instance, survives cold starts). Falls back to
# L1-only when Redis is not configured (local dev).
_DAILY_SERIES_CACHE: Dict[Tuple[str, str], PriceSeries] = {}
_CACHE_LOCK = threading.RLock()

_FETCHERS: Dict[str, Callable[[str], Dict[str, float]]] = dict(FETCHERS)
_DAILY_SERIES_FETCHERS: Dict[str, Callable[[str], PriceSeries]] = dict(DAILY_SERIES_FETCHERS)


def _cache_ttl(series: PriceSeries) -> int:
    return ERROR_CACHE_TTL_SECONDS if series.error else DAILY_SERIES_TTL_SECONDS


def _redis_key(symbol: str, asset_type: str) -> str:
    return f"daily:{asset_type}:{symbol}"


def _serialize_series(series: PriceSeries) -> str:
    return json.dumps(asdict(series), separators=(",", ":"))


def _deserialize_series(raw: str) -> Optional[PriceSeries]:
    try:
        return PriceSeries(**json.loads(raw))
    except (ValueError, TypeError) as e:
        logger.warning("Failed to deserialize cached series: %s", e)
        return None


def _get_cached_daily_series(symbol: str, asset_type: str) -> PriceSeries | None:
    key = (asset_type, symbol)
    # L1 — in-process
    with _CACHE_LOCK:
        series = _DAILY_SERIES_CACHE.get(key)
        if series and time.time() - series.fetched_at < _cache_ttl(series):
            return series
    # L2 — shared Redis. Redis EX handles expiry, but re-check fetched_at to
    # guard against clock skew between the writer and this reader.
    raw = cache_store.cache_get(_redis_key(symbol, asset_type))
    if raw:
        series = _deserialize_series(raw)
        if series and time.time() - series.fetched_at < _cache_ttl(series):
            with _CACHE_LOCK:
                _DAILY_SERIES_CACHE[key] = series  # warm L1
            return series
    return None


def _set_cached_daily_series(symbol: str, asset_type: str, series: PriceSeries) -> PriceSeries:
    key = (asset_type, symbol)
    with _CACHE_LOCK:
        _DAILY_SERIES_CACHE[key] = series
    cache_store.cache_set(_redis_key(symbol, asset_type), _serialize_series(series), _cache_ttl(series))
    return series


def clear_price_change_cache() -> None:
    """Clear in-memory market-data cache. Mainly useful for tests."""
    with _CACHE_LOCK:
        _DAILY_SERIES_CACHE.clear()


def _series_meta(symbol: str, asset_type: str, series: PriceSeries) -> Dict:
    return {
        "symbol": symbol,
        "type": asset_type,
        "source": series.source,
        "updated_at": datetime.fromtimestamp(series.fetched_at, tz=timezone.utc).isoformat(),
        "error": series.error,
        "points": len(series.timestamps),
    }


def register_fetcher(asset_type: str, fetcher: Callable[[str], Dict[str, float]]) -> None:
    """Register a custom yearly fetcher for a new asset type."""
    _FETCHERS[asset_type] = fetcher


def register_daily_series_fetcher(asset_type: str, fetcher: Callable[[str], PriceSeries]) -> None:
    """Register a daily-series fetcher for a new asset type."""
    _DAILY_SERIES_FETCHERS[asset_type] = fetcher


def _normalize_symbol_entry(entry: Dict[str, str]) -> Tuple[str, str]:
    symbol = entry["symbol"].strip().upper()
    asset_type = entry.get("type", "stock").strip().lower()
    return symbol, asset_type


def _fetch_daily_series_cached(symbol: str, asset_type: str) -> PriceSeries:
    cached = _get_cached_daily_series(symbol, asset_type)
    if cached is not None:
        return cached

    fetcher = _DAILY_SERIES_FETCHERS.get(asset_type)
    if fetcher is None:
        return empty_series(None, f"unknown asset type: {asset_type}")

    logger.info("Fetching daily series for %s (%s)", symbol, asset_type)
    try:
        series = fetcher(symbol)
    except Exception as e:
        logger.exception("Failed to fetch daily series for %s (%s): %s", symbol, asset_type, e)
        series = empty_series(None, str(e))

    return _set_cached_daily_series(symbol, asset_type, series)


def _fetch_one_yearly(entry: Dict[str, str]) -> Tuple[str, Dict[str, float], Dict]:
    symbol, asset_type = _normalize_symbol_entry(entry)

    if not symbol:
        return symbol, {}, {
            "symbol": symbol,
            "type": asset_type,
            "source": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "error": "empty symbol",
            "points": 0,
        }

    if asset_type in _DAILY_SERIES_FETCHERS:
        series = _fetch_daily_series_cached(symbol, asset_type)
        yearly = {} if series.error else _compute_yearly_returns(series.timestamps, series.closes)
        meta = _series_meta(symbol, asset_type, series)
        if not yearly and not meta["error"]:
            meta["error"] = "insufficient data"
        return symbol, yearly, meta

    fetcher = _FETCHERS.get(asset_type)
    if fetcher is None:
        now = datetime.now(timezone.utc).isoformat()
        return symbol, {}, {
            "symbol": symbol,
            "type": asset_type,
            "source": None,
            "updated_at": now,
            "error": f"unknown asset type: {asset_type}",
            "points": 0,
        }

    try:
        yearly = fetcher(symbol)
        now = datetime.now(timezone.utc).isoformat()
        return symbol, yearly, {
            "symbol": symbol,
            "type": asset_type,
            "source": "custom",
            "updated_at": now,
            "error": None if yearly else "insufficient data",
            "points": None,
        }
    except Exception as e:
        logger.exception("Custom fetcher failed for %s (%s): %s", symbol, asset_type, e)
        now = datetime.now(timezone.utc).isoformat()
        return symbol, {}, {
            "symbol": symbol,
            "type": asset_type,
            "source": "custom",
            "updated_at": now,
            "error": str(e),
            "points": 0,
        }


def fetch_yearly_returns(symbols: List[Dict[str, str]]) -> dict:
    """Fetch yearly returns for a list of symbols."""
    data: Dict[str, Dict[str, float]] = {}
    meta: Dict[str, Dict] = {}
    all_years: set = set()
    normalized_entries = []
    seen_keys = set()

    for entry in symbols:
        try:
            symbol, asset_type = _normalize_symbol_entry(entry)
        except KeyError:
            logger.warning("Skipping symbol entry without symbol: %s", entry)
            continue
        key = (symbol, asset_type)
        if not symbol or key in seen_keys:
            continue
        seen_keys.add(key)
        normalized_entries.append({"symbol": symbol, "type": asset_type})

    worker_count = min(MAX_YEARLY_WORKERS, max(1, len(normalized_entries)))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [executor.submit(_fetch_one_yearly, entry) for entry in normalized_entries]
        for future in as_completed(futures):
            symbol, yearly, symbol_meta = future.result()
            data[symbol] = yearly
            meta[symbol] = symbol_meta
            all_years.update(yearly.keys())

    ordered_data = {}
    ordered_meta = {}
    for entry in normalized_entries:
        symbol = entry["symbol"]
        yearly = data.get(symbol, {})
        ordered_data[symbol] = yearly
        ordered_meta[symbol] = meta.get(symbol, {
            "symbol": symbol,
            "type": entry["type"],
            "source": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "error": "not fetched",
            "points": 0,
        })

    return {
        "years": sorted(all_years, reverse=True),
        "data": ordered_data,
        "meta": ordered_meta,
    }


def fetch_monthly_returns(symbol: str, asset_type: str, year: int) -> list:
    """Fetch monthly returns for a symbol in a given year."""
    logger.info("Fetching monthly returns for %s (%s) year %d", symbol, asset_type, year)
    clean_sym = symbol.strip().upper()
    clean_type = asset_type.strip().lower()

    if clean_type not in _DAILY_SERIES_FETCHERS:
        return _compute_monthly_returns([], [], year)

    series = _fetch_daily_series_cached(clean_sym, clean_type)
    if series.error:
        return _compute_monthly_returns([], [], year)
    return _compute_monthly_returns(series.timestamps, series.closes, year)


def fetch_daily_returns(symbol: str, asset_type: str, year: int, month: int) -> list:
    """Fetch daily returns for a symbol in a given month."""
    logger.info("Fetching daily returns for %s (%s) %d-%02d", symbol, asset_type, year, month)
    clean_sym = symbol.strip().upper()
    clean_type = asset_type.strip().lower()

    if clean_type not in _DAILY_SERIES_FETCHERS:
        return []

    series = _fetch_daily_series_cached(clean_sym, clean_type)
    if series.error:
        return []
    return _compute_daily_returns_for_month(series.timestamps, series.closes, year, month)


def fetch_monthly_returns_batch(symbols: List[Dict[str, str]], year: int) -> Dict[str, list]:
    """Fetch monthly returns for multiple symbols in a given year."""
    data: Dict[str, list] = {}
    for entry in symbols:
        try:
            symbol = entry["symbol"].strip().upper()
            asset_type = entry.get("type", "stock").strip().lower()
        except (KeyError, AttributeError):
            continue
        if symbol:
            data[symbol] = fetch_monthly_returns(symbol, asset_type, year)
    return data


def run_dca_backtest(payload: Dict) -> Dict:
    """Run a single-symbol DCA backtest using daily price data."""
    symbol = str(payload.get("symbol", "")).strip().upper()
    asset_type = str(payload.get("type", "stock")).strip().lower()
    start_date = _parse_iso_date(payload.get("start_date"), "start_date")
    end_date = _parse_iso_date(payload.get("end_date"), "end_date")
    if end_date < start_date:
        raise ValueError("end_date must be on or after start_date")

    frequency = _normalize_frequency(payload.get("frequency", "monthly"))
    interval = max(1, _safe_int(payload.get("interval"), 1))
    amount = float(payload.get("amount", 0) or 0)
    initial_amount = float(payload.get("initial_amount", 0) or 0)
    day_of_month = _safe_int(payload.get("day_of_month"), start_date.day)
    weekday = payload.get("weekday")
    weekday = None if weekday in (None, "") else max(0, min(6, _safe_int(weekday, 0)))

    if not symbol:
        raise ValueError("symbol is required")
    if amount <= 0 and initial_amount <= 0:
        raise ValueError("amount or initial_amount must be greater than 0")

    series = _fetch_daily_series_cached(symbol, asset_type)
    if series.error:
        raise ValueError(series.error)

    price_points = _series_points_in_range(series.timestamps, series.closes, start_date, end_date)
    if not price_points:
        raise ValueError("no price data in selected date range")

    schedule_dates = _generate_schedule_dates(
        start_date=start_date,
        end_date=end_date,
        frequency=frequency,
        interval=interval,
        anchor_day=day_of_month,
        weekday=weekday,
    )
    execution_dates = _resolve_execution_points(price_points, schedule_dates)

    cashflows: List[dict] = []
    executed_points: List[Tuple] = []
    cumulative_units = 0.0

    first_trade_date, first_trade_price = price_points[0]
    if initial_amount > 0:
        initial_units = initial_amount / first_trade_price
        cumulative_units += initial_units
        cashflows.append({
            "date": first_trade_date.isoformat(),
            "planned_date": start_date.isoformat(),
            "amount": round(initial_amount, 2),
            "price": round(first_trade_price, 6),
            "units": round(initial_units, 8),
            "cum_units": round(cumulative_units, 8),
            "kind": "initial",
        })

    for exec_date, price in execution_dates:
        if amount <= 0:
            break
        units = amount / price
        cumulative_units += units
        executed_points.append((exec_date, price, amount, units, cumulative_units))
        cashflows.append({
            "date": exec_date.isoformat(),
            "planned_date": exec_date.isoformat(),
            "amount": round(amount, 2),
            "price": round(price, 6),
            "units": round(units, 8),
            "cum_units": round(cumulative_units, 8),
            "kind": "recurring",
        })

    equity_curve = _build_equity_curve(
        price_points=price_points,
        executed_points=executed_points,
        initial_amount=initial_amount,
        initial_date=first_trade_date if initial_amount > 0 else None,
        initial_price=first_trade_price if initial_amount > 0 else None,
    )

    invested = initial_amount + amount * len(executed_points)
    last_date, last_price = price_points[-1]
    final_value = cumulative_units * last_price
    profit = final_value - invested
    return_pct = 0.0 if invested == 0 else (profit / invested) * 100
    days = max((last_date - first_trade_date).days, 1)
    annualized_return_pct = 0.0
    if invested > 0 and final_value > 0:
        annualized_return_pct = ((final_value / invested) ** (365 / days) - 1) * 100

    return {
        "symbol": symbol,
        "type": asset_type,
        "source": series.source,
        "frequency": frequency,
        "interval": interval,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "summary": {
            "invested": round(invested, 2),
            "final_value": round(final_value, 2),
            "profit": round(profit, 2),
            "return_pct": round(return_pct, 2),
            "annualized_return_pct": round(annualized_return_pct, 2),
            "trade_count": len(cashflows),
            "last_price": round(last_price, 6),
        },
        "cashflows": cashflows,
        "equity_curve": equity_curve,
    }


def run_crash_stats(payload: Dict) -> Dict:
    """Analyze single-day crash events and recovery for a symbol.

    Request payload:
        symbol: str (e.g. "QQQ")
        type: str (asset type, default "stock")
        start_date: str (YYYY-MM-DD)
        end_date: str (YYYY-MM-DD)
        threshold_pct: float (e.g. 4.77 = drop >= 4.77%)

    Returns:
        dict with crashes list and summary statistics.
    """
    symbol = str(payload.get("symbol", "")).strip().upper()
    asset_type = str(payload.get("type", "stock")).strip().lower()
    start_date = _parse_iso_date(payload.get("start_date"), "start_date")
    end_date = _parse_iso_date(payload.get("end_date"), "end_date")
    threshold_pct = float(payload.get("threshold_pct", 4.77))

    if end_date < start_date:
        raise ValueError("end_date must be on or after start_date")
    if not symbol:
        raise ValueError("symbol is required")
    if threshold_pct <= 0:
        raise ValueError("threshold_pct must be positive")

    series = _fetch_daily_series_cached(symbol, asset_type)
    if series.error:
        raise ValueError(series.error)

    crashes = compute_crash_statistics(
        timestamps=series.timestamps,
        closes=series.closes,
        start_date=start_date,
        end_date=end_date,
        threshold_pct=threshold_pct,
    )

    # Summary stats
    total = len(crashes)
    recovered_count = sum(1 for c in crashes if c["recovered"])
    recovery_days_list = [c["recovery_days"] for c in crashes if c["recovery_days"] is not None]
    avg_recovery = round(sum(recovery_days_list) / len(recovery_days_list), 1) if recovery_days_list else None
    median_recovery = None
    if recovery_days_list:
        sorted_days = sorted(recovery_days_list)
        n = len(sorted_days)
        if n % 2 == 0:
            median_recovery = round((sorted_days[n // 2 - 1] + sorted_days[n // 2]) / 2, 1)
        else:
            median_recovery = round(float(sorted_days[n // 2]), 1)
    max_drop = min((c["drop_pct"] for c in crashes), default=None)
    avg_drop = round(sum(c["drop_pct"] for c in crashes) / len(crashes), 2) if crashes else None

    return {
        "symbol": symbol,
        "type": asset_type,
        "source": series.source,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "threshold_pct": threshold_pct,
        "summary": {
            "total_crashes": total,
            "recovered": recovered_count,
            "not_recovered": total - recovered_count,
            "avg_recovery_days": avg_recovery,
            "median_recovery_days": median_recovery,
            "max_drop_pct": max_drop,
            "avg_drop_pct": avg_drop,
        },
        "crashes": crashes,
    }


def get_crash_chart_data(payload: Dict) -> Dict:
    """Return a window of daily close prices around a crash for charting.

    Request payload:
        symbol: str
        type: str (asset type)
        pre_crash_date: str (YYYY-MM-DD) — the trading day before the crash
        trading_days: int (default 30) — how many trading days after crash to include

    Returns:
        dict with prices list [{date, close}] for the window.
    """
    symbol = str(payload.get("symbol", "")).strip().upper()
    asset_type = str(payload.get("type", "stock")).strip().lower()
    pre_crash_date = _parse_iso_date(payload.get("pre_crash_date"), "pre_crash_date")
    trading_days = _safe_int(payload.get("trading_days"), 30)

    if not symbol:
        raise ValueError("symbol is required")
    if trading_days < 1 or trading_days > 250:
        raise ValueError("trading_days must be between 1 and 250")

    series = _fetch_daily_series_cached(symbol, asset_type)
    if series.error:
        raise ValueError(series.error)

    # Build (date, close, open, high, low) list. OHLC arrays are optional and
    # aligned with timestamps; index into them only when present and valid.
    has_ohlc = bool(series.opens and series.highs and series.lows)
    n = len(series.timestamps)

    def _ohlc_at(arr, i):
        if arr is None or i >= len(arr) or arr[i] is None:
            return None
        return float(arr[i])

    points: list = []
    for i in range(n):
        close = series.closes[i] if i < len(series.closes) else None
        if close is None:
            continue
        dt = datetime.fromtimestamp(series.timestamps[i], tz=timezone.utc).date()
        points.append((
            dt, float(close),
            _ohlc_at(series.opens, i),
            _ohlc_at(series.highs, i),
            _ohlc_at(series.lows, i),
        ))

    # Find the index of pre_crash_date
    start_idx = None
    for idx, point in enumerate(points):
        if point[0] == pre_crash_date:
            start_idx = idx
            break

    if start_idx is None:
        raise ValueError(f"pre_crash_date {pre_crash_date.isoformat()} not found in price data")

    # Extract window: from pre_crash_date through the next trading_days trading days
    # That's start_idx (pre-crash day) + trading_days+1 data points
    end_idx = min(start_idx + trading_days + 1, len(points))
    window = points[start_idx:end_idx]

    def _price_point(d, c, o, h, low):
        p = {"date": d.isoformat(), "close": round(c, 6)}
        if o is not None and h is not None and low is not None:
            p["open"] = round(o, 6)
            p["high"] = round(h, 6)
            p["low"] = round(low, 6)
        return p

    prices = [_price_point(*pt) for pt in window]
    # Only advertise candlestick data when every point in the window has OHLC.
    window_has_ohlc = has_ohlc and all("open" in p for p in prices)

    pre_crash_close = prices[0]["close"] if prices else None

    return {
        "symbol": symbol,
        "type": asset_type,
        "pre_crash_date": pre_crash_date.isoformat(),
        "pre_crash_close": pre_crash_close,
        "trading_days": trading_days,
        "has_ohlc": window_has_ohlc,
        "prices": prices,
    }


def run_leader_breakout(payload: Dict) -> Dict:
    """Scan 沪深主板 stocks for 龙头股回调冲击新高 patterns.

    Request payload (all optional):
        start_date: str (default "2024-09-30")
        threshold: float (default 9.5) — limit-up detection threshold %
        min_consecutive_days: int (default 6) — minimum consecutive limit-up days
        workers: int (default 10)
        force_refresh: bool (default false)
        max_stocks: int (default 0 = all) — for testing
    """
    start_date = str(payload.get("start_date", "2024-09-30"))
    threshold = float(payload.get("threshold", 9.5))
    min_days = int(payload.get("min_consecutive_days", 6))
    workers = int(payload.get("workers", 10))
    force_refresh = bool(payload.get("force_refresh", False))
    max_stocks = int(payload.get("max_stocks", 0))

    if not start_date:
        raise ValueError("start_date is required")
    if threshold <= 0 or threshold > 10:
        raise ValueError("threshold must be between 0 and 10")
    if min_days < 2:
        raise ValueError("min_consecutive_days must be at least 2")
    if workers < 1 or workers > 50:
        raise ValueError("workers must be between 1 and 50")

    # Lazy import — pulls in akshare/pandas only when this endpoint is hit
    from .leader_breakout import run_leader_breakout_scan as _run_leader_breakout_scan

    return _run_leader_breakout_scan(
        start_date=start_date,
        threshold=threshold,
        min_consecutive_days=min_days,
        workers=workers,
        force_refresh=force_refresh,
        max_stocks=max_stocks,
    )


def export_leader_breakout(payload: Dict) -> bytes:
    """Run the scan (uses cache if available) and return Excel file bytes."""
    # Lazy import — pulls in akshare/pandas/openpyxl only when this endpoint is hit
    from .leader_breakout import export_leader_breakout_excel as _export_leader_breakout_excel

    result = run_leader_breakout(payload)
    return _export_leader_breakout_excel(result)
