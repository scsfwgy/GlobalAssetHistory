"""
Yearly price change calculation service.

Data sources:
  - US stocks via Yahoo Finance (yfinance lib, with direct API fallback)
  - Cryptocurrencies via Binance public klines API, with CoinGecko fallback
  - Easily extensible to new types via the _FETCHERS registry
  - Presets and data-source URLs from backend/config/price_change_config.json
"""
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import requests

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 30
BINANCE_MAX_LIMIT = 1000
YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
DAILY_SERIES_TTL_SECONDS = 6 * 60 * 60
ERROR_CACHE_TTL_SECONDS = 5 * 60
MAX_YEARLY_WORKERS = 6

# Paths
CONFIG_PATH = Path(__file__).resolve().parents[3] / "backend" / "config" / "price_change_config.json"

class _ThreadLocalSession:
    """Small thread-safe session wrapper for concurrent market-data fetches."""

    def __init__(self) -> None:
        self.headers: Dict[str, str] = {}
        self._local = threading.local()

    def _get(self) -> requests.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = requests.Session()
            session.headers.update(self.headers)
            self._local.session = session
        return session

    def get(self, *args, **kwargs):
        return self._get().get(*args, **kwargs)


# Shared per-thread sessions (connection pooling without cross-thread Session reuse)
_session = _ThreadLocalSession()
_session.headers.update({"User-Agent": "Mozilla/5.0"})


@dataclass
class PriceSeries:
    timestamps: List[int]
    closes: List[Optional[float]]
    source: Optional[str]
    fetched_at: float
    error: Optional[str] = None


_DAILY_SERIES_CACHE: Dict[Tuple[str, str], PriceSeries] = {}
_CACHE_LOCK = threading.RLock()

# Optional yfinance for reliable Yahoo data
try:
    import yfinance as _yf
    _HAS_YFINANCE = True
except ImportError:
    _HAS_YFINANCE = False


# ---------------------------------------------------------------------------
# Configuration loader
# ---------------------------------------------------------------------------

_CONFIG_CACHE: Optional[Dict] = None


def _load_config() -> Dict:
    global _CONFIG_CACHE
    if _CONFIG_CACHE is not None:
        return _CONFIG_CACHE

    default = {
        "presets": {},
        "color_range": {"min": -100, "max": 100},
        "crypto": {
            "binance_base_url": "https://api.binance.com",
            "okx_base_url": "https://www.okx.com",
            "coingecko_base_url": "https://api.coingecko.com/api/v3",
            "coin_ids": {},
        },
    }

    if not CONFIG_PATH.exists():
        logger.warning("Config not found at %s, using defaults", CONFIG_PATH)
        _CONFIG_CACHE = default
        return default

    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        logger.error("Failed to load config %s: %s, using defaults", CONFIG_PATH, e)
        _CONFIG_CACHE = default
        return default

    # Merge crypto defaults
    crypto = dict(default["crypto"])
    crypto.update(cfg.get("crypto", {}))
    cfg["crypto"] = crypto
    cfg.setdefault("presets", {})

    _CONFIG_CACHE = cfg
    return cfg


def get_presets() -> Dict:
    """Return the presets dict from config."""
    return _load_config().get("presets", {})


def get_color_range() -> Dict:
    """Return the color range config (min, max)."""
    return _load_config().get("color_range", {"min": -100, "max": 100})


def _crypto_config() -> Dict:
    return _load_config().get("crypto", {})


def _coingecko_ids() -> Dict[str, str]:
    return _crypto_config().get("coin_ids", {})


def _binance_base_url() -> str:
    return _crypto_config().get("binance_base_url", "https://api.binance.com")


def _okx_base_url() -> str:
    return _crypto_config().get("okx_base_url", "https://www.okx.com")


def _coingecko_base_url() -> str:
    return _crypto_config().get("coingecko_base_url", "https://api.coingecko.com/api/v3")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _compute_yearly_returns(
    timestamps: List[int],
    closes: List[Optional[float]],
) -> Dict[str, float]:
    """Compute yearly returns using YoY change on year-end close prices.

    For each year, return (last_close_of_year / last_close_of_prev_year - 1) * 100.
    This is the standard financial convention used by published total return data.
    """
    # Build year → last_close mapping
    year_closes: Dict[int, float] = {}
    for ts, c in zip(timestamps, closes):
        if c is not None:
            year = datetime.fromtimestamp(ts, tz=timezone.utc).year
            year_closes[year] = c  # last in chrono order wins = year-end close

    if len(year_closes) < 2:
        return {}

    result = {}
    sorted_years = sorted(year_closes.keys())
    for i in range(1, len(sorted_years)):
        prev, cur = sorted_years[i - 1], sorted_years[i]
        prev_close = year_closes[prev]
        cur_close = year_closes[cur]
        if prev_close == 0:
            continue
        result[str(cur)] = round((cur_close / prev_close - 1) * 100, 2)

    return result


def _empty_series(source: Optional[str] = None, error: Optional[str] = None) -> PriceSeries:
    return PriceSeries([], [], source, time.time(), error)


def _series_from_points(
    timestamps: List[int],
    closes: List[Optional[float]],
    source: str,
) -> PriceSeries:
    return PriceSeries(timestamps, closes, source, time.time())


def _cache_ttl(series: PriceSeries) -> int:
    return ERROR_CACHE_TTL_SECONDS if series.error else DAILY_SERIES_TTL_SECONDS


def _get_cached_daily_series(symbol: str, asset_type: str) -> Optional[PriceSeries]:
    key = (asset_type, symbol)
    with _CACHE_LOCK:
        series = _DAILY_SERIES_CACHE.get(key)
        if series and time.time() - series.fetched_at < _cache_ttl(series):
            return series
    return None


def _set_cached_daily_series(symbol: str, asset_type: str, series: PriceSeries) -> PriceSeries:
    key = (asset_type, symbol)
    with _CACHE_LOCK:
        _DAILY_SERIES_CACHE[key] = series
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


# ---------------------------------------------------------------------------
# Stock fetcher — Yahoo Finance
# ---------------------------------------------------------------------------

def _fetch_stock(symbol: str) -> Dict[str, float]:
    """Fetch yearly returns for a stock symbol.

    Tries direct Yahoo Finance chart API first (lightweight),
    falls back to yfinance for better cookie/crumb handling.
    """
    series = _fetch_daily_series_stock(symbol)
    if series.error:
        return {}
    return _compute_yearly_returns(series.timestamps, series.closes)


def _fetch_stock_yfinance(symbol: str) -> Dict[str, float]:
    """Fetch via yfinance library (handles cookies/crumbs/rate limits)."""
    try:
        ticker = _yf.Ticker(symbol)
        hist = ticker.history(period="max")
        if hist.empty:
            logger.warning("yfinance returned empty for %s", symbol)
            return {}

        timestamps = [int(t.timestamp()) for t in hist.index]
        # yfinance versions handle auto_adjust differently; be safe:
        # use Adj Close if available (includes dividends), fall back to Close
        if "Adj Close" in hist.columns and not hist["Adj Close"].isna().all():
            closes = hist["Adj Close"].tolist()
        else:
            closes = hist["Close"].tolist()
        return _compute_yearly_returns(timestamps, closes)
    except Exception as e:
        logger.error("yfinance failed for %s: %s", symbol, e)
        return {}


def _fetch_stock_direct(symbol: str) -> Dict[str, float]:
    """Fetch via direct Yahoo Finance chart API (no authentication)."""
    try:
        resp = _session.get(
            f"{YAHOO_BASE}/{symbol}",
            params={
                "period1": 0,
                "period2": int(time.time()),
                "interval": "1d",
            },
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.error("Direct Yahoo fetch failed for %s: %s", symbol, e)
        return {}

    try:
        result = data["chart"]["result"][0]
        timestamps = result["timestamp"]
        # Prefer adjclose over close for total-return accuracy (includes dividends)
        adjclose = result.get("indicators", {}).get("adjclose")
        if adjclose and adjclose[0].get("adjclose"):
            closes = adjclose[0]["adjclose"]
        else:
            closes = result["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError):
        logger.error("Unexpected Yahoo response format for %s", symbol)
        return {}

    return _compute_yearly_returns(timestamps, closes)


def _fetch_daily_series_stock(symbol: str) -> PriceSeries:
    """Fetch daily close data for a stock via Yahoo, with yfinance fallback."""
    direct = _fetch_daily_series_stock_direct(symbol)
    if not direct.error:
        return direct

    if _HAS_YFINANCE:
        yf_series = _fetch_daily_series_stock_yfinance(symbol)
        if not yf_series.error:
            return yf_series
        return _empty_series(
            source="yahoo/yfinance",
            error=f"{direct.error}; {yf_series.error}",
        )

    return direct


def _fetch_daily_series_stock_direct(symbol: str) -> PriceSeries:
    try:
        resp = _session.get(
            f"{YAHOO_BASE}/{symbol}",
            params={"period1": 0, "period2": int(time.time()), "interval": "1d"},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.error("Yahoo daily fetch failed for %s: %s", symbol, e)
        return _empty_series("yahoo", str(e))

    try:
        result = data["chart"]["result"][0]
        timestamps = result["timestamp"]
        adjclose = result.get("indicators", {}).get("adjclose")
        if adjclose and adjclose[0].get("adjclose"):
            closes = adjclose[0]["adjclose"]
        else:
            closes = result["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError) as e:
        logger.error("Unexpected Yahoo response for %s", symbol)
        return _empty_series("yahoo", f"unexpected response: {e}")

    if not timestamps:
        return _empty_series("yahoo", "empty data")
    return _series_from_points(timestamps, closes, "yahoo")


def _fetch_daily_series_stock_yfinance(symbol: str) -> PriceSeries:
    try:
        ticker = _yf.Ticker(symbol)
        hist = ticker.history(period="max")
        if hist.empty:
            logger.warning("yfinance returned empty for %s", symbol)
            return _empty_series("yfinance", "empty data")

        timestamps = [int(t.timestamp()) for t in hist.index]
        if "Adj Close" in hist.columns and not hist["Adj Close"].isna().all():
            closes = hist["Adj Close"].tolist()
        else:
            closes = hist["Close"].tolist()
        return _series_from_points(timestamps, closes, "yfinance")
    except Exception as e:
        logger.error("yfinance daily fetch failed for %s: %s", symbol, e)
        return _empty_series("yfinance", str(e))


# ---------------------------------------------------------------------------
# Crypto fetcher — Binance (primary) + CoinGecko (fallback)
# ---------------------------------------------------------------------------

def _binance_pair(symbol: str) -> str:
    s = symbol.upper().strip()
    return s if s.endswith("USDT") else s + "USDT"


def _fetch_crypto(symbol: str) -> Dict[str, float]:
    """Fetch yearly returns for crypto via Binance → OKX → CoinGecko."""
    series = _fetch_daily_series_crypto(symbol)
    if series.error:
        return {}
    return _compute_yearly_returns(series.timestamps, series.closes)


def _fetch_crypto_binance(symbol: str) -> Dict[str, float]:
    """Fetch yearly returns via Binance public klines API."""
    pair = _binance_pair(symbol)
    base_url = _binance_base_url()
    all_klines: List[list] = []
    start_ms = int(datetime(2013, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)

    for _ in range(20):  # max 20 requests = ~55 years of daily data
        try:
            resp = _session.get(
                f"{base_url}/api/v3/klines",
                params={
                    "symbol": pair,
                    "interval": "1d",
                    "startTime": start_ms,
                    "limit": BINANCE_MAX_LIMIT,
                },
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            klines = resp.json()
            if not klines or not isinstance(klines, list):
                break
            all_klines.extend(klines)
            if len(klines) < BINANCE_MAX_LIMIT:
                break
            start_ms = klines[-1][0] + 1
            time.sleep(0.05)
        except Exception as e:
            logger.error("Binance fetch failed for %s via %s: %s", pair, base_url, e)
            break

    if not all_klines:
        return {}

    timestamps = [k[0] // 1000 for k in all_klines]  # ms → s
    closes = [float(k[4]) for k in all_klines]
    return _compute_yearly_returns(timestamps, closes)


def _fetch_daily_series_crypto_binance(symbol: str) -> PriceSeries:
    """Fetch daily close data for crypto via Binance."""
    pair = _binance_pair(symbol)
    base_url = _binance_base_url()
    all_klines: List[list] = []
    start_ms = int(datetime(2013, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)

    for _ in range(20):
        try:
            resp = _session.get(
                f"{base_url}/api/v3/klines",
                params={"symbol": pair, "interval": "1d", "startTime": start_ms, "limit": BINANCE_MAX_LIMIT},
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            klines = resp.json()
            if not klines or not isinstance(klines, list):
                break
            all_klines.extend(klines)
            if len(klines) < BINANCE_MAX_LIMIT:
                break
            start_ms = klines[-1][0] + 1
            time.sleep(0.05)
        except Exception as e:
            logger.error("Binance daily fetch failed for %s: %s", pair, e)
            return _empty_series("binance", str(e))

    if not all_klines:
        return _empty_series("binance", "empty data")

    timestamps = [k[0] // 1000 for k in all_klines]
    closes = [float(k[4]) for k in all_klines]
    return _series_from_points(timestamps, closes, "binance")


def _okx_pair(symbol: str) -> str:
    s = symbol.upper().strip()
    return f"{s}-USDT"


def _fetch_crypto_okx(symbol: str) -> Dict[str, float]:
    """Fetch yearly returns via OKX public history-candles API.

    Paginates backwards using the 'before' parameter (max 100 per page).
    """
    pair = _okx_pair(symbol)
    base_url = _okx_base_url()
    all_candles: List[list] = []

    for _ in range(100):  # max 100 pages = 10000 days = ~27 years
        try:
            params: Dict = {
                "instId": pair,
                "bar": "1Dutc",
                "limit": "100",
            }
            if all_candles:
                # OKX returns newest-first; use oldest candle's ts for pagination
                params["before"] = str(all_candles[-1][0])

            resp = _session.get(
                f"{base_url}/api/v5/market/history-candles",
                params=params,
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            body = resp.json()
            if body.get("code") != "0":
                logger.warning("OKX API error for %s: %s", pair, body.get("msg"))
                break

            candles = body.get("data", [])
            if not candles:
                break
            all_candles.extend(candles)
            if len(candles) < 100:
                break
            time.sleep(0.1)
        except Exception as e:
            logger.error("OKX fetch failed for %s: %s", pair, e)
            break

    if not all_candles:
        return {}

    # OKX returns newest-first; reverse to oldest-first for compute
    all_candles.reverse()
    timestamps = [int(c[0]) // 1000 for c in all_candles]  # ms → s
    closes = [float(c[4]) for c in all_candles]
    return _compute_yearly_returns(timestamps, closes)


def _fetch_daily_series_crypto_okx(symbol: str) -> PriceSeries:
    """Fetch daily close data for crypto via OKX."""
    pair = _okx_pair(symbol)
    base_url = _okx_base_url()
    all_candles: List[list] = []

    for _ in range(100):
        try:
            params: Dict = {"instId": pair, "bar": "1Dutc", "limit": "100"}
            if all_candles:
                params["before"] = str(all_candles[-1][0])
            resp = _session.get(
                f"{base_url}/api/v5/market/history-candles",
                params=params,
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            body = resp.json()
            if body.get("code") != "0":
                msg = body.get("msg") or "api error"
                logger.warning("OKX API error for %s: %s", pair, msg)
                return _empty_series("okx", msg)
            candles = body.get("data", [])
            if not candles:
                break
            all_candles.extend(candles)
            if len(candles) < 100:
                break
            time.sleep(0.1)
        except Exception as e:
            logger.error("OKX daily fetch failed for %s: %s", pair, e)
            return _empty_series("okx", str(e))

    if not all_candles:
        return _empty_series("okx", "empty data")

    all_candles.reverse()
    timestamps = [int(c[0]) // 1000 for c in all_candles]
    closes = [float(c[4]) for c in all_candles]
    return _series_from_points(timestamps, closes, "okx")


def _fetch_crypto_coingecko(symbol: str) -> Dict[str, float]:
    """Fetch yearly returns via CoinGecko OHLC API."""
    ids = _coingecko_ids()
    coin_id = ids.get(symbol.upper())
    if not coin_id:
        logger.warning("No CoinGecko ID mapping for %s in config", symbol)
        return {}

    base_url = _coingecko_base_url()
    try:
        resp = _session.get(
            f"{base_url}/coins/{coin_id}/ohlc",
            params={"vs_currency": "usd", "days": "max"},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.error("CoinGecko fetch failed for %s (%s): %s", symbol, coin_id, e)
        return {}

    if not data or not isinstance(data, list):
        return {}

    timestamps = [int(item[0] / 1000) for item in data]  # ms → s
    closes = [float(item[4]) for item in data]

    return _compute_yearly_returns(timestamps, closes)


def _fetch_daily_series_crypto_coingecko(symbol: str) -> PriceSeries:
    """Fetch daily close data for crypto via CoinGecko OHLC."""
    ids = _coingecko_ids()
    coin_id = ids.get(symbol.upper())
    if not coin_id:
        return _empty_series("coingecko", "missing coin id mapping")

    base_url = _coingecko_base_url()
    try:
        resp = _session.get(
            f"{base_url}/coins/{coin_id}/ohlc",
            params={"vs_currency": "usd", "days": "max"},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.error("CoinGecko daily fetch failed for %s (%s): %s", symbol, coin_id, e)
        return _empty_series("coingecko", str(e))

    if not data or not isinstance(data, list):
        return _empty_series("coingecko", "empty data")

    timestamps = [int(item[0] / 1000) for item in data]
    closes = [float(item[4]) for item in data]
    return _series_from_points(timestamps, closes, "coingecko")


def _fetch_daily_series_crypto(symbol: str) -> PriceSeries:
    """Fetch crypto daily close data via Binance → OKX → CoinGecko."""
    errors = []
    for fetcher in (
        _fetch_daily_series_crypto_binance,
        _fetch_daily_series_crypto_okx,
        _fetch_daily_series_crypto_coingecko,
    ):
        series = fetcher(symbol)
        if not series.error:
            return series
        errors.append(f"{series.source}: {series.error}")
    logger.warning("All crypto data sources failed for %s", symbol)
    return _empty_series("crypto", "; ".join(errors))


# ---------------------------------------------------------------------------
# China A-share fetcher — East Money API (free, no auth)
# ---------------------------------------------------------------------------

_EAST_MONEY_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"


def _cn_secid(symbol: str) -> str:
    """Map A-share code to East Money secid format."""
    s = symbol.strip().upper()
    # 000xxx / 600xxx → Shanghai (1.), 399xxx / 002xxx / 300xxx → Shenzhen (0.)
    if s.startswith("399"):
        return f"0.{s}"
    return f"1.{s}"


def _parse_east_money_klines(data: List[str]) -> tuple:
    """Parse East Money kline strings into (timestamps, closes).

    Each kline: "2024-01-02,open,close,high,low,..."
    """
    timestamps = []
    closes = []
    for line in data:
        parts = line.split(",")
        if len(parts) < 3:
            continue
        try:
            # Date format 2024-01-02 → timestamp
            dt = datetime.strptime(parts[0], "%Y-%m-%d")
            # Replace with timezone-aware: treat as UTC date
            ts = int(dt.replace(tzinfo=timezone.utc).timestamp())
            close = float(parts[2])
            timestamps.append(ts)
            closes.append(close)
        except (ValueError, IndexError):
            continue
    return timestamps, closes


_EAST_MONEY_PARAMS = {
    "ut": "fa5fd1943c7b386f172d6893dbfd32bb",
    "fields1": "f1,f2,f3,f4,f5,f6",
    "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    "klt": "101",
    "fqt": "1",
    "end": "20500101",
}


def _fetch_cn_stock(symbol: str) -> Dict[str, float]:
    """Fetch yearly returns for A-share indices via East Money API."""
    series = _fetch_daily_series_cn_stock(symbol)
    if series.error:
        return {}
    return _compute_yearly_returns(series.timestamps, series.closes)


def _fetch_daily_series_cn_stock(symbol: str) -> PriceSeries:
    """Fetch daily close data for A-share via East Money."""
    secid = _cn_secid(symbol)
    try:
        resp = _session.get(
            _EAST_MONEY_URL,
            params={**_EAST_MONEY_PARAMS, "secid": secid, "lmt": "5000"},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        body = resp.json()
    except Exception as e:
        logger.error("East Money daily fetch failed for %s: %s", symbol, e)
        return _empty_series("eastmoney", str(e))

    klines = body.get("data", {}).get("klines", [])
    if not klines:
        logger.warning("East Money returned no data for %s", symbol)
        return _empty_series("eastmoney", "empty data")

    timestamps, closes = _parse_east_money_klines(klines)
    if not timestamps:
        return _empty_series("eastmoney", "parse failed")
    return _series_from_points(timestamps, closes, "eastmoney")


def _fetch_daily_closes_cn_stock(symbol: str) -> tuple:
    """Fetch daily close data for A-share via East Money. Returns (timestamps, closes)."""
    series = _fetch_daily_series_cn_stock(symbol)
    return series.timestamps, series.closes


# ---------------------------------------------------------------------------
# Fetcher registry — extend here for new asset types
# ---------------------------------------------------------------------------

_FETCHERS: Dict[str, Callable[[str], Dict[str, float]]] = {
    "crypto": _fetch_crypto,
    "stock": _fetch_stock,
    "cn_stock": _fetch_cn_stock,
}

_DAILY_SERIES_FETCHERS: Dict[str, Callable[[str], PriceSeries]] = {
    "crypto": _fetch_daily_series_crypto,
    "stock": _fetch_daily_series_stock,
    "cn_stock": _fetch_daily_series_cn_stock,
}


def register_fetcher(asset_type: str, fetcher: Callable[[str], Dict[str, float]]) -> None:
    """Register a custom fetcher for a new asset type."""
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
        return _empty_series(None, f"unknown asset type: {asset_type}")

    logger.info("Fetching daily series for %s (%s)", symbol, asset_type)
    try:
        series = fetcher(symbol)
    except Exception as e:
        logger.exception("Failed to fetch daily series for %s (%s): %s", symbol, asset_type, e)
        series = _empty_series(None, str(e))

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
        logger.warning("Unknown asset type '%s' for symbol %s", asset_type, symbol)
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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def fetch_yearly_returns(symbols: List[Dict[str, str]]) -> dict:
    """Fetch yearly returns for a list of symbols.

    Args:
        symbols: [{"symbol": "AAPL", "type": "stock"}, ...]

    Returns:
        {
          "years": ["2025", "2024", ...],
          "data": {
            "SYMBOL": {"2025": 12.3, "2024": -5.2, ...},
            ...
          },
          "meta": {
            "SYMBOL": {"source": "yahoo", "error": null, "updated_at": "...", ...}
          }
        }
    """
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

    # Preserve requested column order in the JSON object for clients that iterate keys.
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
        data[symbol] = yearly

    sorted_years = sorted(all_years, reverse=True)

    return {
        "years": sorted_years,
        "data": ordered_data,
        "meta": ordered_meta,
    }


def _compute_monthly_returns(
    timestamps: List[int],
    closes: List[Optional[float]],
    year: int,
) -> List[dict]:
    """Compute monthly returns for a specific year.

    Month returns use end-of-month closes:
    current month-end close / previous month-end close - 1.

    Returns [{"month": 1, "return": 5.2}, ...] (month is 1-12, return is % or None).
    """
    month_end_closes: Dict[Tuple[int, int], float] = {}
    for ts, c in zip(timestamps, closes):
        if c is None:
            continue
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        month_end_closes[(dt.year, dt.month)] = c

    result = []
    for m in range(1, 13):
        cur_close = month_end_closes.get((year, m))
        prev_key = (year - 1, 12) if m == 1 else (year, m - 1)
        prev_close = month_end_closes.get(prev_key)
        if cur_close is not None and prev_close not in (None, 0):
            ret = round((cur_close / prev_close - 1) * 100, 2)
            result.append({"month": m, "return": ret})
        else:
            result.append({"month": m, "return": None})
    return result


def _compute_daily_returns_for_month(
    timestamps: List[int],
    closes: List[Optional[float]],
    year: int,
    month: int,
) -> List[dict]:
    """Compute daily returns for a specific month from daily closes.

    Daily return uses the previous available close:
    current close / previous close - 1.
    """
    result: List[dict] = []
    prev_close: Optional[float] = None

    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        daily_return = None
        if prev_close not in (None, 0):
            daily_return = round((close / prev_close - 1) * 100, 2)

        if dt.year == year and dt.month == month:
            result.append({
                "day": dt.day,
                "date": dt.date().isoformat(),
                "return": daily_return,
                "close": round(close, 6),
            })

        prev_close = close

    return result


def _series_points_in_range(
    timestamps: List[int],
    closes: List[Optional[float]],
    start_date: date,
    end_date: date,
) -> List[Tuple[date, float]]:
    points: List[Tuple[date, float]] = []
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        current_date = datetime.fromtimestamp(ts, tz=timezone.utc).date()
        if start_date <= current_date <= end_date:
            points.append((current_date, float(close)))
    return points


def _normalize_frequency(frequency: str) -> str:
    clean = (frequency or "monthly").strip().lower()
    if clean not in {"once", "daily", "weekly", "monthly"}:
        raise ValueError("frequency must be one of once, daily, weekly, monthly")
    return clean


def _safe_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_iso_date(value: str, field_name: str) -> date:
    if not value:
        raise ValueError(f"{field_name} is required")
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as e:
        raise ValueError(f"{field_name} must be in YYYY-MM-DD format") from e


def _next_month_anchor(current: date, months: int, target_day: int) -> date:
    total_months = (current.year * 12 + (current.month - 1)) + months
    year = total_months // 12
    month = total_months % 12 + 1
    if month == 12:
        next_month = date(year + 1, 1, 1)
    else:
        next_month = date(year, month + 1, 1)
    last_day = (next_month - timedelta(days=1)).day
    return date(year, month, min(target_day, last_day))


def _generate_schedule_dates(
    start_date: date,
    end_date: date,
    frequency: str,
    interval: int,
    anchor_day: Optional[int] = None,
    weekday: Optional[int] = None,
) -> List[date]:
    schedule: List[date] = []
    current = start_date

    if frequency == "once":
        return [start_date]

    if frequency == "daily":
        step = timedelta(days=interval)
        while current <= end_date:
            schedule.append(current)
            current += step
        return schedule

    if frequency == "weekly":
        target_weekday = 0 if weekday is None else max(0, min(6, weekday))
        delta = (target_weekday - start_date.weekday()) % 7
        current = start_date + timedelta(days=delta)
        step = timedelta(days=7 * interval)
        while current <= end_date:
            schedule.append(current)
            current += step
        return schedule

    target_day = anchor_day or start_date.day
    current = date(start_date.year, start_date.month, min(target_day, start_date.day))
    if current < start_date:
        current = _next_month_anchor(current, 1, target_day)

    while current <= end_date:
        if current >= start_date:
            schedule.append(current)
        current = _next_month_anchor(current, interval, target_day)

    return schedule


def _resolve_execution_points(
    price_points: List[Tuple[date, float]],
    schedule_dates: List[date],
) -> List[Tuple[date, float]]:
    executed: List[Tuple[date, float]] = []
    pointer = 0
    last_used_date: Optional[date] = None

    for planned_date in schedule_dates:
        while pointer < len(price_points) and price_points[pointer][0] < planned_date:
            pointer += 1
        if pointer >= len(price_points):
            break
        exec_date, price = price_points[pointer]
        if last_used_date == exec_date:
            continue
        executed.append((exec_date, price))
        last_used_date = exec_date

    return executed


def _build_equity_curve(
    price_points: List[Tuple[date, float]],
    executed_points: List[Tuple[date, float, float, float, float]],
    initial_amount: float,
    initial_date: Optional[date],
    initial_price: Optional[float],
) -> List[dict]:
    curve: List[dict] = []
    invested = initial_amount
    units = 0.0
    exec_idx = 0

    if initial_amount > 0 and initial_date is not None and initial_price not in (None, 0):
        units = initial_amount / float(initial_price)

    for point_date, price in price_points:
        while exec_idx < len(executed_points) and executed_points[exec_idx][0] == point_date:
            _, _, amount, bought_units, cum_units = executed_points[exec_idx]
            invested += amount
            units = cum_units
            exec_idx += 1

        value = units * price
        curve.append({
            "date": point_date.isoformat(),
            "price": round(price, 6),
            "invested": round(invested, 2),
            "value": round(value, 2),
        })

    return curve


def _fetch_daily_closes_stock(symbol: str) -> tuple:
    """Fetch daily close data for a stock via Yahoo chart API. Returns (timestamps, closes)."""
    series = _fetch_daily_series_stock(symbol)
    return series.timestamps, series.closes


def _fetch_daily_closes_crypto_okx(symbol: str) -> tuple:
    """Fetch daily close data for crypto via OKX. Returns (timestamps, closes)."""
    series = _fetch_daily_series_crypto_okx(symbol)
    return series.timestamps, series.closes


def _check_year_in_data(timestamps: List[int], year: int) -> bool:
    """Check if a given year has data points."""
    for ts in timestamps:
        if datetime.fromtimestamp(ts, tz=timezone.utc).year == year:
            return True
    return False


def _fetch_daily_closes_crypto_binance(symbol: str) -> tuple:
    """Fetch daily close data for crypto via Binance. Returns (timestamps, closes)."""
    series = _fetch_daily_series_crypto_binance(symbol)
    return series.timestamps, series.closes


def _fetch_daily_closes_crypto_coingecko(symbol: str) -> tuple:
    """Fetch daily close data for crypto via CoinGecko OHLC. Returns (timestamps, closes)."""
    series = _fetch_daily_series_crypto_coingecko(symbol)
    return series.timestamps, series.closes


def fetch_monthly_returns(symbol: str, asset_type: str, year: int) -> list:
    """Fetch monthly returns for a symbol in a given year.

    Returns [{"month": 1, "return": 5.2}, ...] (12 months, return is % or None).
    """
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
        if not symbol:
            continue
        months = fetch_monthly_returns(symbol, asset_type, year)
        data[symbol] = months
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
    executed_points: List[Tuple[date, float, float, float, float]] = []
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
