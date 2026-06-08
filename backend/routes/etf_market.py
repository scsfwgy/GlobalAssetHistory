"""A-share ETF real-time market data blueprint using Tencent Finance."""

import logging
import re
from datetime import datetime, timezone
from typing import Optional

import requests
from flask import Blueprint, jsonify, request

logger = logging.getLogger(__name__)

# East Money fund NAV — tries to import akshare, falls back gracefully
try:
    import akshare as _ak
    _HAS_AKSHARE = True
except ImportError:
    _HAS_AKSHARE = False

etf_market_bp = Blueprint("etf_market", __name__, url_prefix="/api/etf-market")

_TENCENT_QUOTE_URL = "https://qt.gtimg.cn/q="
_REQUEST_TIMEOUT = 10

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
        page_rows = stock_data.get("day", [])
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

    # Fetch NAV history for premium calculation (best-effort)
    nav_map = _fetch_etf_nav(symbol, parsed[0]["date"], parsed[-1]["date"])
    for p in parsed:
        nav = nav_map.get(p["date"])
        p["nav"] = nav
        if nav and nav > 0:
            p["premium_pct"] = round((p["close"] - nav) / nav * 100, 2)
        else:
            p["premium_pct"] = None

    # Backfill latest premium from real-time quote (NAV has T+1 delay)
    _backfill_live_premium(symbol, parsed)

    return jsonify({
        "symbol": symbol,
        "bars": parsed,
        "count": len(parsed),
        "has_premium": any(b["premium_pct"] is not None for b in parsed),
    })


def _backfill_live_premium(symbol: str, bars: list) -> None:
    """Backfill the last bar's premium from real-time quote (NAV has T+1 delay)."""
    if not bars or bars[-1].get("premium_pct") is not None:
        return
    try:
        tsym = _tencent_symbol(symbol)
        resp = requests.get(
            "https://qt.gtimg.cn/q=" + tsym,
            timeout=_REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        parsed = _parse_tencent_quote(resp.text)
        if parsed and parsed.get("premium") is not None:
            bars[-1]["premium_pct"] = parsed["premium"]
    except Exception as e:
        logger.warning("Live premium backfill failed for %s: %s", symbol, e)


def _fetch_etf_nav(symbol: str, start_date: str, end_date: str) -> dict:
    """Fetch ETF NAV history from East Money fund API. Returns {date_str: nav}."""
    if not _HAS_AKSHARE:
        return {}
    try:
        s = start_date.replace("-", "")
        e = end_date.replace("-", "")
        df = _ak.fund_etf_fund_info_em(fund=symbol, start_date=s, end_date=e)
        if df is None or df.empty:
            return {}
        nav_map = {}
        for _, row in df.iterrows():
            dt = row["净值日期"]
            if hasattr(dt, "strftime"):
                dt = dt.strftime("%Y-%m-%d")
            else:
                dt = str(dt)[:10]
            nav_map[dt] = float(row["单位净值"])
        return nav_map
    except Exception as e:
        logger.warning("NAV fetch failed for %s: %s", symbol, e)
        return {}
