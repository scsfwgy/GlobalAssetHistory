"""Market data fetchers for stocks, crypto, and China A-share indices."""

import logging
import time
from datetime import datetime, timezone
from typing import Dict, List

from .common import BINANCE_MAX_LIMIT, REQUEST_TIMEOUT, YAHOO_BASE, PriceSeries, ThreadLocalSession, empty_series, series_from_points
from .config import binance_base_url, coingecko_base_url, coingecko_ids, okx_base_url
from .calculations import _compute_yearly_returns

logger = logging.getLogger(__name__)
_session = ThreadLocalSession()
_session.headers.update({"User-Agent": "Mozilla/5.0"})

try:
    import yfinance as _yf
    _HAS_YFINANCE = True
except ImportError:
    _HAS_YFINANCE = False

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
        return empty_series(
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
        return empty_series("yahoo", str(e))

    try:
        result = data["chart"]["result"][0]
        timestamps = result["timestamp"]
        quote = result["indicators"]["quote"][0]
        adjclose = result.get("indicators", {}).get("adjclose")
        if adjclose and adjclose[0].get("adjclose"):
            closes = adjclose[0]["adjclose"]
        else:
            closes = quote["close"]
        opens = quote.get("open")
        highs = quote.get("high")
        lows = quote.get("low")
    except (KeyError, IndexError, TypeError) as e:
        logger.error("Unexpected Yahoo response for %s", symbol)
        return empty_series("yahoo", f"unexpected response: {e}")

    if not timestamps:
        return empty_series("yahoo", "empty data")
    return series_from_points(timestamps, closes, "yahoo", opens=opens, highs=highs, lows=lows)


def _fetch_daily_series_stock_yfinance(symbol: str) -> PriceSeries:
    try:
        ticker = _yf.Ticker(symbol)
        hist = ticker.history(period="max")
        if hist.empty:
            logger.warning("yfinance returned empty for %s", symbol)
            return empty_series("yfinance", "empty data")

        timestamps = [int(t.timestamp()) for t in hist.index]
        if "Adj Close" in hist.columns and not hist["Adj Close"].isna().all():
            closes = hist["Adj Close"].tolist()
        else:
            closes = hist["Close"].tolist()
        opens = hist["Open"].tolist() if "Open" in hist.columns else None
        highs = hist["High"].tolist() if "High" in hist.columns else None
        lows = hist["Low"].tolist() if "Low" in hist.columns else None
        return series_from_points(timestamps, closes, "yfinance", opens=opens, highs=highs, lows=lows)
    except Exception as e:
        logger.error("yfinance daily fetch failed for %s: %s", symbol, e)
        return empty_series("yfinance", str(e))


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
    base_url = binance_base_url()
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
    base_url = binance_base_url()
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
            return empty_series("binance", str(e))

    if not all_klines:
        return empty_series("binance", "empty data")

    timestamps = [k[0] // 1000 for k in all_klines]
    opens = [float(k[1]) for k in all_klines]
    highs = [float(k[2]) for k in all_klines]
    lows = [float(k[3]) for k in all_klines]
    closes = [float(k[4]) for k in all_klines]
    return series_from_points(timestamps, closes, "binance", opens=opens, highs=highs, lows=lows)


def _okx_pair(symbol: str) -> str:
    s = symbol.upper().strip()
    return f"{s}-USDT"


def _fetch_crypto_okx(symbol: str) -> Dict[str, float]:
    """Fetch yearly returns via OKX public history-candles API.

    Paginates backwards using the 'before' parameter (max 100 per page).
    """
    pair = _okx_pair(symbol)
    base_url = okx_base_url()
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
    base_url = okx_base_url()
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
                return empty_series("okx", msg)
            candles = body.get("data", [])
            if not candles:
                break
            all_candles.extend(candles)
            if len(candles) < 100:
                break
            time.sleep(0.1)
        except Exception as e:
            logger.error("OKX daily fetch failed for %s: %s", pair, e)
            return empty_series("okx", str(e))

    if not all_candles:
        return empty_series("okx", "empty data")

    all_candles.reverse()
    timestamps = [int(c[0]) // 1000 for c in all_candles]
    opens = [float(c[1]) for c in all_candles]
    highs = [float(c[2]) for c in all_candles]
    lows = [float(c[3]) for c in all_candles]
    closes = [float(c[4]) for c in all_candles]
    return series_from_points(timestamps, closes, "okx", opens=opens, highs=highs, lows=lows)


def _fetch_crypto_coingecko(symbol: str) -> Dict[str, float]:
    """Fetch yearly returns via CoinGecko OHLC API."""
    ids = coingecko_ids()
    coin_id = ids.get(symbol.upper())
    if not coin_id:
        logger.warning("No CoinGecko ID mapping for %s in config", symbol)
        return {}

    base_url = coingecko_base_url()
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
    ids = coingecko_ids()
    coin_id = ids.get(symbol.upper())
    if not coin_id:
        return empty_series("coingecko", "missing coin id mapping")

    base_url = coingecko_base_url()
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
        return empty_series("coingecko", str(e))

    if not data or not isinstance(data, list):
        return empty_series("coingecko", "empty data")

    timestamps = [int(item[0] / 1000) for item in data]
    opens = [float(item[1]) for item in data]
    highs = [float(item[2]) for item in data]
    lows = [float(item[3]) for item in data]
    closes = [float(item[4]) for item in data]
    return series_from_points(timestamps, closes, "coingecko", opens=opens, highs=highs, lows=lows)


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
    return empty_series("crypto", "; ".join(errors))


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


def _cn_stock_secid(code: str) -> str:
    """Map individual A-share stock code to East Money secid format.

    Individual stock exchange mapping (not indices):
    - Shenzhen (0.): 000xxx, 001xxx, 002xxx, 003xxx, 300xxx, 301xxx
    - Shanghai (1.): 600xxx, 601xxx, 603xxx, 605xxx, 688xxx
    """
    s = code.strip().upper()
    if s[:3] in ("000", "001", "002", "003", "300", "301"):
        return f"0.{s}"
    if s[:3] in ("600", "601", "603", "605", "688"):
        return f"1.{s}"
    # Default: fall back to index-style mapping
    return _cn_secid(s)


def _parse_east_money_klines(data: List[str]) -> tuple:
    """Parse East Money kline strings into (timestamps, closes, opens, highs, lows).

    Each kline: "2024-01-02,open,close,high,low,..."
    """
    timestamps = []
    closes = []
    opens = []
    highs = []
    lows = []
    for line in data:
        parts = line.split(",")
        if len(parts) < 5:
            continue
        try:
            # Date format 2024-01-02 → timestamp
            dt = datetime.strptime(parts[0], "%Y-%m-%d")
            # Replace with timezone-aware: treat as UTC date
            ts = int(dt.replace(tzinfo=timezone.utc).timestamp())
            timestamps.append(ts)
            opens.append(float(parts[1]))
            closes.append(float(parts[2]))
            highs.append(float(parts[3]))
            lows.append(float(parts[4]))
        except (ValueError, IndexError):
            continue
    return timestamps, closes, opens, highs, lows


def _parse_east_money_klines_full(data: List[str]) -> list:
    """Parse East Money kline strings returning full OHLC + change_pct.

    Each kline: "date,open,close,high,low,volume,amount,amplitude,
                  change_pct,change_amount,turnover_rate"

    Returns list of dicts with keys:
        date_str, open, close, high, low, change_pct
    """
    results = []
    for line in data:
        parts = line.split(",")
        if len(parts) < 9:
            continue
        try:
            results.append({
                "date_str": parts[0],
                "open": float(parts[1]),
                "close": float(parts[2]),
                "high": float(parts[3]),
                "low": float(parts[4]),
                "change_pct": float(parts[8]) if parts[8] != "-" else 0.0,
            })
        except (ValueError, IndexError):
            continue
    return results


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
        return empty_series("eastmoney", str(e))

    klines = body.get("data", {}).get("klines", [])
    if not klines:
        logger.warning("East Money returned no data for %s", symbol)
        return empty_series("eastmoney", "empty data")

    timestamps, closes, opens, highs, lows = _parse_east_money_klines(klines)
    if not timestamps:
        return empty_series("eastmoney", "parse failed")
    return series_from_points(timestamps, closes, "eastmoney", opens=opens, highs=highs, lows=lows)


def _fetch_daily_closes_cn_stock(symbol: str) -> tuple:
    """Fetch daily close data for A-share via East Money. Returns (timestamps, closes)."""
    series = _fetch_daily_series_cn_stock(symbol)
    return series.timestamps, series.closes



FETCHERS = {
    "crypto": _fetch_crypto,
    "stock": _fetch_stock,
    "cn_stock": _fetch_cn_stock,
}

DAILY_SERIES_FETCHERS = {
    "crypto": _fetch_daily_series_crypto,
    "stock": _fetch_daily_series_stock,
    "cn_stock": _fetch_daily_series_cn_stock,
}
