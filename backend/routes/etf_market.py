"""A-share ETF real-time market data blueprint using Tencent Finance."""

import json
import logging
import math
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from service.price_change.price_change_service import _fetch_daily_series_cached

import requests
from flask import Blueprint, jsonify, request

logger = logging.getLogger(__name__)

etf_market_bp = Blueprint("etf_market", __name__, url_prefix="/api/etf-market")

# ETF fee data — scraped locally from East Money fund profile pages.
# Deployed servers read this static JSON instead of accessing Chinese sites.
_FEE_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "etf_fees.json"
_fee_data: dict = {}


def _load_fee_data() -> None:
    """Load etf_fees.json into the module-level cache on first access."""
    global _fee_data
    if _fee_data:
        return
    try:
        with open(_FEE_DATA_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        _fee_data = raw.get("funds", {})
        logger.info("Loaded ETF fee data for %d funds", len(_fee_data))
    except Exception as e:
        logger.warning("Failed to load ETF fee data from %s: %s", _FEE_DATA_PATH, e)
        _fee_data = {}


_TENCENT_QUOTE_URL = "https://qt.gtimg.cn/q="
_REQUEST_TIMEOUT = 10
_TRACKING_ERROR_TTL_SECONDS = 6 * 60 * 60
_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "price_change_config.json"
_tracking_error_cache: dict[str, tuple[float, dict]] = {}
_benchmark_map: dict[str, tuple[str, str]] = {}


def _load_benchmark_map() -> dict[str, tuple[str, str]]:
    """Build ETF → benchmark mapping from the shared preset config."""
    global _benchmark_map
    if _benchmark_map:
        return _benchmark_map
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            presets = json.load(f).get("presets", {})
    except Exception as e:
        logger.warning("Failed to load ETF benchmark config from %s: %s", _CONFIG_PATH, e)
        presets = {}

    mapping: dict[str, tuple[str, str]] = {}
    for entry in presets.get("cn_etf_nasdaq100", {}).get("symbols", []):
        symbol = str(entry.get("symbol", "")).strip()
        if symbol:
            mapping[symbol] = ("QQQ", "QQQ")
    for entry in presets.get("cn_etf_sp500", {}).get("symbols", []):
        symbol = str(entry.get("symbol", "")).strip()
        if symbol:
            mapping[symbol] = ("SPY", "SPY")
    _benchmark_map = mapping
    return _benchmark_map


def _benchmark_for_etf(symbol: str) -> tuple[Optional[str], Optional[str]]:
    """Return Yahoo benchmark symbol and display label for supported ETFs."""
    return _load_benchmark_map().get(symbol.strip(), (None, None))

# ---------------------------------------------------------------------------
# Field indices for Tencent real-time quote (split by "~")
# ETF-specific fields marked with *
# ---------------------------------------------------------------------------
F_NAME = 1
F_CODE = 2
F_PRICE = 3         # 最新价
F_PREV_CLOSE = 4    # 昨收
F_OPEN = 5          # 今开
F_VOLUME = 6        # 成交量(手)
F_CHANGE_AMT = 31   # 涨跌额
F_CHANGE_PCT = 32   # 涨跌幅%
F_HIGH = 33         # 最高
F_LOW = 34          # 最低
F_AMOUNT = 37       # 成交额(万元)
F_TURNOVER = 38     # 换手率%
F_AMPLITUDE = 43    # 振幅%
F_MC_CIRC = 44      # 流通市值(亿)
F_MC_TOTAL = 45     # 总市值(亿)
F_PREMIUM = 77      # 溢价率% (ETF 折溢价)
F_WEEK52_HIGH = 67  # 52周最高 *
F_WEEK52_LOW = 68   # 52周最低 *
F_IOPV = 85         # 实时参考净值 *
F_VOL_RATIO = 46    # 量比


def _parse_tencent_quote(raw: str) -> Optional[dict]:
    """Parse a single Tencent quote line into a dict. Returns None on failure."""
    # Format: v_sh513300="field0~field1~...~fieldN";
    # or     : v_sz159501="51~field1~...~fieldN";
    m = re.match(r'v_(?:sh|sz)(\w+)="(.*?)";?$', raw.strip())
    if not m:
        return None

    code = m.group(1)
    fields = m.group(2).split("~")
    if len(fields) < 40:
        return None

    def _f(i: int, default=""):
        """Safely get field value, returning default if out of range."""
        if i < len(fields) and fields[i]:
            return fields[i]
        return default

    def _num(s: str) -> Optional[float]:
        try:
            return float(s)
        except (ValueError, TypeError):
            return None

    # Determine market from prefix
    prefix = fields[0] if fields[0] else ""
    market = "SH" if prefix == "1" else "SZ"

    price = _num(_f(F_PRICE))
    prev_close = _num(_f(F_PREV_CLOSE))
    open_price = _num(_f(F_OPEN))
    high = _num(_f(F_HIGH))
    low = _num(_f(F_LOW))
    change_pct = _num(_f(F_CHANGE_PCT))
    amplitude = _num(_f(F_AMPLITUDE))
    volume = _num(_f(F_VOLUME))
    amount = _num(_f(F_AMOUNT))        # 万元
    turnover = _num(_f(F_TURNOVER))
    mc_circ = _num(_f(F_MC_CIRC))      # 亿
    mc_total = _num(_f(F_MC_TOTAL))     # 亿
    premium = _num(_f(F_PREMIUM))
    week52_high = _num(_f(F_WEEK52_HIGH))
    week52_low = _num(_f(F_WEEK52_LOW))
    iopv = _num(_f(F_IOPV))
    vol_ratio = _num(_f(F_VOL_RATIO))

    return {
        "code": code,
        "market": market,
        "name": _f(F_NAME),
        "price": price,
        "prev_close": prev_close,
        "open": open_price,
        "high": high,
        "low": low,
        "change_pct": change_pct,
        "amplitude": amplitude,
        "volume": int(volume) if volume else None,
        "amount": int(amount * 10000) if amount else None,  # 万元 → 元
        "turnover": turnover,
        "mc_circ": mc_circ,         # 亿
        "mc_total": mc_total,       # 亿
        "premium": premium,         # %
        "week52_high": week52_high,
        "week52_low": week52_low,
        "iopv": iopv,
        "vol_ratio": vol_ratio,
    }


def _tencent_symbol(symbol: str) -> str:
    """Map a 6-digit code to Tencent quote format (shXXXXXX / szXXXXXX)."""
    s = symbol.strip().upper()
    # 5xx/6xx → Shanghai, 0xx/1xx/2xx/3xx → Shenzhen
    if s.startswith(("5", "6")):
        return f"sh{s}"
    return f"sz{s}"


def _parse_fee_pct(raw: str | None) -> float | None:
    """Parse fee string like '0.60%' → 0.60. Returns None on failure."""
    if not raw or not isinstance(raw, str):
        return None
    try:
        return float(raw.replace("%", ""))
    except (ValueError, TypeError):
        return None


def _daily_return_map_from_rows(rows: list[dict]) -> dict[str, float]:
    result = {}
    for i in range(1, len(rows)):
        prev = rows[i - 1].get("close")
        curr = rows[i].get("close")
        if prev and curr:
            result[rows[i]["date"]] = curr / prev - 1
    return result


def _series_close_map(series) -> dict[str, float]:
    result = {}
    for ts, close in zip(series.timestamps, series.closes):
        if close is None:
            continue
        dt = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        result[dt] = float(close)
    return result


def _daily_return_map_from_series(series) -> dict[str, float]:
    result = {}
    items = []
    for ts, close in zip(series.timestamps, series.closes):
        if close is None:
            continue
        dt = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        items.append((dt, float(close)))
    for i in range(1, len(items)):
        prev = items[i - 1][1]
        curr = items[i][1]
        if prev:
            result[items[i][0]] = curr / prev - 1
    return result


def _tracking_error_pct(values: list[float]) -> Optional[float]:
    if len(values) < 2:
        return None
    avg = sum(values) / len(values)
    variance = sum((v - avg) ** 2 for v in values) / (len(values) - 1)
    return round(math.sqrt(variance) * math.sqrt(252) * 100, 2)


def _fetch_etf_history_rows(symbol: str, days: int = 120) -> list[dict]:
    """Fetch ETF daily rows with date and close, oldest to newest."""
    tsym = _tencent_symbol(symbol)
    end_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    all_rows = []
    max_pages = 10

    for _ in range(max_pages):
        try:
            resp = requests.get(
                "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get",
                params={"param": f"{tsym},day,,{end_date},640,qfq"},
                timeout=_REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            body = resp.json()
        except requests.RequestException as e:
            logger.warning("Tencent kline fetch failed for tracking error %s: %s", tsym, e)
            return []

        if body.get("code") != 0:
            break

        stock_data = body.get("data", {}).get(tsym, {})
        page_rows = stock_data.get("day") or stock_data.get("qfqday", [])
        if not page_rows:
            break

        all_rows.extend(page_rows)
        if len(all_rows) >= days or len(page_rows) < 640:
            break
        end_date = page_rows[0][0]

    seen = set()
    parsed = []
    for row in reversed(all_rows):
        if row[0] in seen:
            continue
        seen.add(row[0])
        try:
            parsed.append({"date": row[0], "close": float(row[2])})
        except (ValueError, IndexError):
            continue

    return list(reversed(parsed[:days]))


def _compute_tracking_error_history(
    symbol: str, etf_rows: list[dict], nav_map: Optional[dict] = None
) -> dict:
    """Compute rolling annualized tracking error vs the ETF benchmark.

    When *nav_map* is provided (date → NAV), also computes NAV-based daily
    tracking deviations — a purer measure of how closely the fund's actual
    net asset value tracks the underlying index, without market-price noise.
    """
    benchmark_symbol, benchmark_label = _benchmark_for_etf(symbol)
    if not benchmark_symbol or not etf_rows:
        return {"available": False, "benchmark": benchmark_label, "current": None, "avg": None, "history": []}

    nav_hash = ""
    if nav_map:
        nav_dates = sorted(nav_map.keys())
        nav_hash = f":nav{nav_dates[0]}:{nav_dates[-1]}:{len(nav_dates)}"
    cache_key = f"{symbol}:{etf_rows[0]['date']}:{etf_rows[-1]['date']}:{len(etf_rows)}{nav_hash}"
    cached = _tracking_error_cache.get(cache_key)
    if cached and time.time() - cached[0] < _TRACKING_ERROR_TTL_SECONDS:
        return cached[1]

    benchmark = _fetch_daily_series_cached(benchmark_symbol, "stock")
    if benchmark.error:
        data = {
            "available": False,
            "benchmark": benchmark_label,
            "benchmark_symbol": benchmark_symbol,
            "error": benchmark.error,
            "current": None,
            "avg": None,
            "history": [],
        }
        _tracking_error_cache[cache_key] = (time.time(), data)
        return data

    etf_returns = _daily_return_map_from_rows(etf_rows)
    benchmark_returns = _daily_return_map_from_series(benchmark)
    benchmark_closes = _series_close_map(benchmark)
    dates = sorted(set(etf_returns) & set(benchmark_returns))
    deviations = [(dt, etf_returns[dt] - benchmark_returns[dt]) for dt in dates]

    window = 60
    history = []
    for idx in range(len(deviations)):
        if idx + 1 < window:
            continue
        slice_vals = [v for _, v in deviations[idx + 1 - window:idx + 1]]
        te = _tracking_error_pct(slice_vals)
        if te is not None:
            history.append({"date": deviations[idx][0], "tracking_error_pct": te})

    comparison = []
    if dates:
        first_date = dates[0]
        etf_close_by_date = {row["date"]: row["close"] for row in etf_rows if row.get("close")}
        first_etf_close = etf_close_by_date.get(first_date)
        first_benchmark_close = benchmark_closes.get(first_date)
        if first_etf_close and first_benchmark_close:
            for dt in dates:
                etf_close = etf_close_by_date.get(dt)
                benchmark_close = benchmark_closes.get(dt)
                if not etf_close or not benchmark_close:
                    continue
                etf_return_pct = (etf_close / first_etf_close - 1) * 100
                benchmark_return_pct = (benchmark_close / first_benchmark_close - 1) * 100
                etf_profit_per_10k = etf_return_pct * 100
                benchmark_profit_per_10k = benchmark_return_pct * 100
                comparison.append({
                    "date": dt,
                    "etf_return_pct": round(etf_return_pct, 2),
                    "benchmark_return_pct": round(benchmark_return_pct, 2),
                    "excess_return_pct": round(etf_return_pct - benchmark_return_pct, 2),
                    "etf_profit_per_10k": round(etf_profit_per_10k, 0),
                    "benchmark_profit_per_10k": round(benchmark_profit_per_10k, 0),
                    "profit_diff_per_10k": round(etf_profit_per_10k - benchmark_profit_per_10k, 0),
                })

    current = history[-1]["tracking_error_pct"] if history else None
    avg = round(sum(item["tracking_error_pct"] for item in history) / len(history), 2) if history else None

    recent_deviations = deviations[-30:]
    tracking_error_30d_pct = round(sum(v for _, v in recent_deviations) * 100, 2) if recent_deviations else None
    profit_diff_30d_per_10k = None
    if len(comparison) >= 2:
        start = comparison[-31] if len(comparison) > 30 else comparison[0]
        end = comparison[-1]
        etf_30d_return = (1 + end["etf_return_pct"] / 100) / (1 + start["etf_return_pct"] / 100) - 1
        benchmark_30d_return = (1 + end["benchmark_return_pct"] / 100) / (1 + start["benchmark_return_pct"] / 100) - 1
        profit_diff_30d_per_10k = round((etf_30d_return - benchmark_30d_return) * 10000, 0)

    # ── Price-level daily deviation series (for chart overlay) ──
    price_tracking_daily = [
        {"date": dt, "deviation_pct": round(dev * 100, 4)}
        for dt, dev in deviations
    ]

    # ── NAV-based daily tracking deviation (pure NAV vs index, no market-price noise) ──
    nav_tracking_daily: list[dict] = []
    nav_tracking_mae_30d: Optional[float] = None
    if nav_map:
        nav_dates_sorted = sorted(nav_map.keys())
        for i in range(1, len(nav_dates_sorted)):
            dt = nav_dates_sorted[i]
            prev_dt = nav_dates_sorted[i - 1]
            nav_val = nav_map[dt]
            prev_nav_val = nav_map[prev_dt]
            if not prev_nav_val or prev_nav_val <= 0:
                continue
            nav_ret = nav_val / prev_nav_val - 1
            bench_ret = benchmark_returns.get(dt)
            if bench_ret is None:
                continue
            dev = nav_ret - bench_ret
            nav_tracking_daily.append({
                "date": dt,
                "nav_return_pct": round(nav_ret * 100, 4),
                "benchmark_return_pct": round(bench_ret * 100, 4),
                "deviation_pct": round(dev * 100, 4),
            })
        if nav_tracking_daily:
            recent = nav_tracking_daily[-30:]
            nav_tracking_mae_30d = round(
                sum(abs(d["deviation_pct"]) for d in recent) / len(recent), 4
            )

    data = {
        "available": bool(history),
        "benchmark": benchmark_label,
        "benchmark_symbol": benchmark_symbol,
        "window_days": window,
        "current": current,
        "avg": avg,
        "tracking_error_30d_pct": tracking_error_30d_pct,
        "profit_diff_30d_per_10k": profit_diff_30d_per_10k,
        "history": history,
        "comparison": comparison,
        "price_tracking_daily": price_tracking_daily,
        "nav_tracking_mae_30d": nav_tracking_mae_30d,
        "nav_tracking_daily": nav_tracking_daily,
    }
    _tracking_error_cache[cache_key] = (time.time(), data)
    return data


@etf_market_bp.route("/quote", methods=["GET"])
def quote():
    """Return real-time quotes for a list of ETF symbols.

    Query params:
        symbols: comma-separated ETF codes, e.g. "513300,159501,513650"
    """
    raw = request.args.get("symbols", "")
    if not raw:
        return jsonify({"error": "symbols parameter is required"}), 400

    codes = [c.strip() for c in raw.split(",") if c.strip()]
    if not codes:
        return jsonify({"error": "no valid symbols"}), 400

    # Build Tencent query string
    qs = ",".join(_tencent_symbol(c) for c in codes)

    try:
        resp = requests.get(_TENCENT_QUOTE_URL + qs, timeout=_REQUEST_TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.error("Tencent quote fetch failed for %s: %s", qs, e)
        return jsonify({"error": f"upstream fetch failed: {e}"}), 502

    # Parse each line; the response is multiple lines like:
    # v_sh513300="1~name~...";
    results = []
    for line in resp.text.strip().split("\n"):
        if not line.strip():
            continue
        try:
            parsed = _parse_tencent_quote(line)
            if parsed:
                results.append(parsed)
        except Exception as e:
            logger.warning("Failed to parse Tencent quote line: %s", e)

    # Augment with fund fee data from locally scraped JSON
    _load_fee_data()
    for q in results:
        fee = _fee_data.get(q["code"], {})
        q["mgmt_fee"] = fee.get("mgmt_fee")       # e.g. "0.60%"
        q["custody_fee"] = fee.get("custody_fee") # e.g. "0.20%"
        # Parse fee rates for sorting / computation
        mgmt_val = _parse_fee_pct(q.get("mgmt_fee"))
        custody_val = _parse_fee_pct(q.get("custody_fee"))
        if mgmt_val is not None and custody_val is not None:
            total = mgmt_val + custody_val
            q["total_fee"] = round(total, 2)              # e.g. 0.80 (%)
            q["fee_per_10k"] = round(10000 * total / 100, 2)  # e.g. 80.00 (元)
        else:
            q["total_fee"] = None
            q["fee_per_10k"] = None
        # Premium cost per 10k RMB: negative = loss (you overpaid)
        premium = q.get("premium")
        if premium is not None:
            q["premium_cost_per_10k"] = -round(10000 * premium / 100, 0)
        else:
            q["premium_cost_per_10k"] = None

        tracking_rows = _fetch_etf_history_rows(q["code"], 180)
        tracking = _compute_tracking_error_history(q["code"], tracking_rows) if tracking_rows else None
        q["tracking_error_avg"] = tracking.get("avg") if tracking else None
        q["tracking_error_current"] = tracking.get("current") if tracking else None
        q["tracking_error_benchmark"] = tracking.get("benchmark") if tracking else None
        q["tracking_error_30d_pct"] = tracking.get("tracking_error_30d_pct") if tracking else None
        q["profit_diff_30d_per_10k"] = tracking.get("profit_diff_30d_per_10k") if tracking else None

    return jsonify({
        "quotes": results,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })


@etf_market_bp.route("/history", methods=["GET"])
def history():
    """Return recent daily OHLCV history for an ETF symbol.

    Query params:
        symbol: ETF code, e.g. "513300"
        days: number of recent trading days (default 120, max 500)
    """
    symbol = request.args.get("symbol", "").strip()
    if not symbol:
        return jsonify({"error": "symbol parameter is required"}), 400

    try:
        days = int(request.args.get("days", 120))
    except ValueError:
        days = 120
    days = max(1, min(days, 500))

    tsym = _tencent_symbol(symbol)
    end_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    all_rows = []
    max_pages = 50

    for _ in range(max_pages):
        try:
            resp = requests.get(
                "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get",
                params={"param": f"{tsym},day,,{end_date},640,qfq"},
                timeout=_REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            body = resp.json()
        except requests.RequestException as e:
            logger.error("Tencent kline fetch failed for %s: %s", tsym, e)
            return jsonify({"error": f"upstream fetch failed: {e}"}), 502

        if body.get("code") != 0:
            break

        stock_data = body.get("data", {}).get(tsym, {})
        page_rows = stock_data.get("day") or stock_data.get("qfqday", [])
        if not page_rows:
            break

        all_rows.extend(page_rows)
        if len(all_rows) >= days or len(page_rows) < 640:
            break
        end_date = page_rows[0][0]

    if not all_rows:
        return jsonify({"error": "no data"}), 404

    # Parse OHLCV, dedup.  all_rows is oldest→newest per page, newest pages first
    # so overall it's newest→oldest across pages.  Reverse to get oldest→newest.
    seen = set()
    parsed = []
    for row in reversed(all_rows):
        if row[0] in seen:
            continue
        seen.add(row[0])
        try:
            amount_raw = float(row[8]) if len(row) > 8 and row[8] else 0  # 万元
            parsed.append({
                "date": row[0],
                "open": float(row[1]),
                "close": float(row[2]),
                "high": float(row[3]),
                "low": float(row[4]),
                "volume": float(row[5]) if row[5] else 0,
                "amount": amount_raw * 10000,  # 万元 → 元
            })
        except (ValueError, IndexError):
            continue

    # parsed is now newest→first (from the reversed iteration).
    # Take the most recent N, then reverse to oldest→newest for display.
    parsed = list(reversed(parsed[:days]))

    # Calculate daily change % and amplitude
    for i, p in enumerate(parsed):
        if i > 0 and parsed[i - 1]["close"]:
            prev = parsed[i - 1]["close"]
            p["change_pct"] = round((p["close"] - prev) / prev * 100, 2) if prev else 0
        else:
            p["change_pct"] = 0
        # Amplitude: (high - low) / prev_close
        if i > 0 and parsed[i - 1]["close"] and p["high"] and p["low"]:
            p["amplitude_pct"] = round((p["high"] - p["low"]) / parsed[i - 1]["close"] * 100, 2)
        else:
            p["amplitude_pct"] = 0
        # Amount: already in parsed from kline (万元), keep as-is
        # The amount field is already in yuan from the kline parser

    # Fetch NAV history for premium calculation (best-effort).
    # Falls back to live quote premium if NAV API is unreachable (e.g. from US servers).
    nav_map = _fetch_etf_nav(symbol, parsed[0]["date"], parsed[-1]["date"])
    live_premium = _fetch_live_premium(symbol)

    if nav_map:
        # QDII ETFs (tracking overseas markets like Nasdaq / S&P 500):
        # NAV is published T+1 (after US market close), so the A-share
        # price on day T trades against the last known NAV — T-1.
        # Premium(T) = (close(T) - NAV(T-1)) / NAV(T-1) × 100%
        nav_dates_sorted = sorted(nav_map.keys())
        for p in parsed:
            p_date = p["date"]
            prev_nav = None
            prev_date = None
            # Walk backwards through NAV dates to find most recent < p_date
            for nd in reversed(nav_dates_sorted):
                if nd < p_date:
                    prev_nav = nav_map[nd]
                    prev_date = nd
                    break
            p["nav"] = prev_nav
            p["nav_date"] = prev_date
            if prev_nav and prev_nav > 0:
                p["premium_pct"] = round((p["close"] - prev_nav) / prev_nav * 100, 2)
            else:
                p["premium_pct"] = None
        # Backfill the latest bar from live IOPV premium if T-1 NAV is still
        # unavailable (edge case: very new ETF with no historical NAV).
        if live_premium is not None and parsed:
            last = parsed[-1]
            if last.get("premium_pct") is None:
                last["premium_pct"] = live_premium
    elif live_premium is not None:
        # NAV API unavailable — use live premium as approximation for all bars
        for p in parsed:
            p["premium_pct"] = live_premium
            p["nav"] = None

    premium_approx = bool(not nav_map and live_premium is not None)

    # ── Stats summary ──
    first_date = parsed[0]["date"] if parsed else None
    last_date = parsed[-1]["date"] if parsed else None
    days_since_first = None
    if first_date:
        try:
            fd = datetime.strptime(first_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            days_since_first = (datetime.now(timezone.utc) - fd).days
        except ValueError:
            pass

    # N-month returns (from last bar backwards)
    def _ret_over_bars(bars, months):
        target_days = months * 21  # ~trading days per month
        if len(bars) <= target_days:
            return None
        prev = bars[-1 - target_days]["close"]
        curr = bars[-1]["close"]
        if prev and prev > 0:
            return round((curr / prev - 1) * 100, 2)
        return None

    ret_1m = _ret_over_bars(parsed, 1)
    ret_3m = _ret_over_bars(parsed, 3)

    # Average daily turnover (amount)
    amounts = [b["amount"] for b in parsed if b.get("amount")]
    avg_amount = round(sum(amounts) / len(amounts), 2) if amounts else None

    # Fund company — match known suffixes from the real-time quote name
    company = None
    try:
        tsym = _tencent_symbol(symbol)
        qr = requests.get("https://qt.gtimg.cn/q=" + tsym, timeout=_REQUEST_TIMEOUT)
        parsed_qt = _parse_tencent_quote(qr.text) if qr.status_code == 200 else None
        if parsed_qt:
            name = parsed_qt.get("name", "")
            # Common fund company name patterns in A-share ETF names
            for kw, co in [
                ("华夏", "华夏基金"), ("南方", "南方基金"), ("易方达", "易方达基金"),
                ("嘉实", "嘉实基金"), ("博时", "博时基金"), ("广发", "广发基金"),
                ("国泰", "国泰基金"), ("华安", "华安基金"), ("富国", "富国基金"),
                ("招商", "招商基金"), ("华泰柏瑞", "华泰柏瑞基金"), ("摩根", "摩根基金"),
                ("汇添富", "汇添富基金"), ("景顺", "景顺长城基金"), ("大成", "大成基金"),
            ]:
                if kw in name:
                    company = co
                    break
            if not company:
                company = name  # fallback: use full name
    except Exception:
        pass

    # Fund management / custody fees from locally scraped JSON
    _load_fee_data()
    fee_info = _fee_data.get(symbol, {})
    mgmt_fee = fee_info.get("mgmt_fee")
    custody_fee = fee_info.get("custody_fee")
    # Compute total fee rate and annual cost per 10k RMB
    mgmt_val = _parse_fee_pct(mgmt_fee)
    custody_val = _parse_fee_pct(custody_fee)
    if mgmt_val is not None and custody_val is not None:
        total_fee = round(mgmt_val + custody_val, 2)
        fee_per_10k = round(10000 * total_fee / 100, 2)
    else:
        total_fee = None
        fee_per_10k = None

    tracking_error = _compute_tracking_error_history(symbol, parsed, nav_map)
    tracking_by_date = {
        item["date"]: item["tracking_error_pct"]
        for item in tracking_error.get("history", [])
    }
    comparison_by_date = {
        item["date"]: item
        for item in tracking_error.get("comparison", [])
    }
    nav_dev_by_date = {
        item["date"]: item["deviation_pct"]
        for item in tracking_error.get("nav_tracking_daily", [])
    }
    nav_ret_by_date = {
        item["date"]: item["nav_return_pct"]
        for item in tracking_error.get("nav_tracking_daily", [])
    }
    bench_ret_by_date = {
        item["date"]: item["benchmark_return_pct"]
        for item in tracking_error.get("nav_tracking_daily", [])
    }
    price_dev_by_date = {
        item["date"]: item["deviation_pct"]
        for item in tracking_error.get("price_tracking_daily", [])
    }
    for p in parsed:
        p["tracking_error_pct"] = tracking_by_date.get(p["date"])
        # Daily price-level deviation (ETF price return - benchmark return)
        p["price_tracking_deviation_pct"] = price_dev_by_date.get(p["date"])
        comp = comparison_by_date.get(p["date"])
        if comp:
            p["etf_cum_return_pct"] = comp.get("etf_return_pct")
            p["benchmark_cum_return_pct"] = comp.get("benchmark_return_pct")
            p["excess_cum_return_pct"] = comp.get("excess_return_pct")
            p["etf_profit_per_10k"] = comp.get("etf_profit_per_10k")
            p["benchmark_profit_per_10k"] = comp.get("benchmark_profit_per_10k")
            p["profit_diff_per_10k"] = comp.get("profit_diff_per_10k")
        # NAV-based daily tracking deviation (pure NAV vs index)
        nd = nav_dev_by_date.get(p["date"])
        p["nav_tracking_deviation_pct"] = nd
        p["nav_return_pct"] = nav_ret_by_date.get(p["date"])
        p["benchmark_daily_return_pct"] = bench_ret_by_date.get(p["date"])

    return jsonify({
        "symbol": symbol,
        "bars": parsed,
        "count": len(parsed),
        "has_premium": any(b["premium_pct"] is not None for b in parsed),
        "premium_approx": premium_approx,
        "stats": {
            "first_date": first_date,
            "last_date": last_date,
            "days_since_listed": days_since_first,
            "ret_1m": ret_1m,
            "ret_3m": ret_3m,
            "avg_daily_amount": avg_amount,
            "company": company,
            "mgmt_fee": mgmt_fee,
            "custody_fee": custody_fee,
            "total_fee": total_fee,
            "fee_per_10k": fee_per_10k,
            "tracking_error_avg": tracking_error.get("avg"),
            "tracking_error_current": tracking_error.get("current"),
            "tracking_error_benchmark": tracking_error.get("benchmark"),
            "tracking_error_window_days": tracking_error.get("window_days"),
            "tracking_error_30d_pct": tracking_error.get("tracking_error_30d_pct"),
            "nav_tracking_mae_30d": tracking_error.get("nav_tracking_mae_30d"),
            "nav_tracking_benchmark": tracking_error.get("benchmark"),
            "profit_diff_30d_per_10k": tracking_error.get("profit_diff_30d_per_10k"),
        },
    })


def _fetch_live_premium(symbol: str) -> Optional[float]:
    """Return the current premium rate from the Tencent real-time quote, or None."""
    try:
        tsym = _tencent_symbol(symbol)
        resp = requests.get(
            "https://qt.gtimg.cn/q=" + tsym,
            timeout=_REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        parsed = _parse_tencent_quote(resp.text)
        if parsed and parsed.get("premium") is not None:
            return parsed["premium"]
    except Exception as e:
        logger.warning("Live premium fetch failed for %s: %s", symbol, e)
    return None


def _fetch_etf_nav(symbol: str, start_date: str, end_date: str) -> dict:
    """Fetch ETF NAV history from East Money fund API. Returns {date_str: nav}.

    Uses api.fund.eastmoney.com (different from push2his.eastmoney.com) which
    may be reachable from US servers. Falls back gracefully on any error.
    """
    import time as _time

    nav_map = {}
    page_size = 50
    max_pages = 20  # safety: ~1000 data points max

    s = start_date.replace("-", "-")  # keep YYYY-MM-DD
    e = end_date.replace("-", "-")

    headers = {
        "User-Agent": "Mozilla/5.0",
        "Referer": f"https://fundf10.eastmoney.com/jjjz_{symbol}.html",
    }

    for page in range(1, max_pages + 1):
        try:
            resp = requests.get(
                "https://api.fund.eastmoney.com/f10/lsjz",
                params={
                    "fundCode": symbol,
                    "pageIndex": str(page),
                    "pageSize": str(page_size),
                    "startDate": s,
                    "endDate": e,
                    "_": str(int(_time.time() * 1000)),
                },
                headers=headers,
                timeout=_REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            body = resp.json()
        except Exception as exc:
            logger.warning("NAV API unreachable for %s: %s", symbol, exc)
            break

        items = body.get("Data", {}).get("LSJZList", [])
        if not items:
            break

        oldest_in_page = None
        for item in items:
            dt = item.get("FSRQ", "")  # 净值日期，接口按新→旧排序
            nav = item.get("DWJZ")     # 单位净值
            if dt and nav:
                try:
                    nav_map[dt] = float(nav)
                except (ValueError, TypeError):
                    pass
                oldest_in_page = dt  # items 为新→旧，最后一个有效值即本页最旧

        # East Money 实际每页只返回 ~20 条，忽略请求的 pageSize，所以不能用
        # len(items) < page_size 作为终止条件（否则第一页就 break，拉不到更早
        # 的历史净值）。改为翻到的最旧日期已早于 start_date 时停止。
        if oldest_in_page and oldest_in_page <= start_date:
            break

    return nav_map
