"""
Yearly price change API blueprint.
"""
import logging

from flask import Blueprint, jsonify, request

from service.price_change.price_change_service import (
    _fetch_daily_series_cached,
    fetch_daily_returns,
    fetch_yearly_returns,
    fetch_monthly_returns,
    fetch_monthly_returns_batch,
    get_presets,
    get_color_range,
    run_dca_backtest,
    run_crash_stats,
    get_crash_chart_data,
    run_leader_breakout,
    export_leader_breakout,
)

logger = logging.getLogger(__name__)

price_change_bp = Blueprint("price_change", __name__, url_prefix="/api/price-change")


@price_change_bp.route("/config", methods=["GET"])
def config():
    """Return presets and other config for the frontend."""
    presets_dict = get_presets()
    # Return as list to preserve insertion order (Flask's jsonify sorts keys by default)
    presets_list = [
        {"key": k, "label": v["label"], "symbols": v["symbols"]}
        for k, v in presets_dict.items()
    ]
    color_range = get_color_range()
    return jsonify({"presets": presets_list, "color_range": color_range})


@price_change_bp.route("/yearly", methods=["POST"])
def get_yearly_returns():
    """Return yearly returns for given symbols.

    Request body:
        {"symbols": [{"symbol": "AAPL", "type": "stock"}, ...]}

    Returns:
        {"years": [...], "data": {"SYMBOL": {"year": pct, ...}, ...}}
    """
    body = request.get_json(silent=True) or {}
    symbols = body.get("symbols", [])

    if not symbols:
        return jsonify({"error": "symbols list is required"}), 400

    try:
        result = fetch_yearly_returns(symbols)
        return jsonify(result)
    except Exception as e:
        logger.exception("Failed to fetch yearly returns: %s", e)
        return jsonify({"error": str(e)}), 500


@price_change_bp.route("/monthly", methods=["POST"])
def get_monthly_returns():
    """Return monthly returns for a symbol in a given year.

    Request body:
        {"symbol": "AAPL", "type": "stock", "year": 2024}

    Returns:
        {"symbol": "AAPL", "year": 2024, "months": [{"month": 1, "return": 5.2}, ...]}
    """
    body = request.get_json(silent=True) or {}
    symbol = body.get("symbol", "").strip().upper()
    asset_type = body.get("type", "stock").strip().lower()
    year = body.get("year")

    if not symbol or not year:
        return jsonify({"error": "symbol and year are required"}), 400

    try:
        year = int(year)
    except (ValueError, TypeError):
        return jsonify({"error": "year must be an integer"}), 400

    try:
        months = fetch_monthly_returns(symbol, asset_type, year)
        return jsonify({"symbol": symbol, "type": asset_type, "year": year, "months": months})
    except Exception as e:
        logger.exception("Failed to fetch monthly returns: %s", e)
        return jsonify({"error": str(e)}), 500


@price_change_bp.route("/monthly-batch", methods=["POST"])
def get_monthly_returns_batch():
    """Return monthly returns for multiple symbols in a given year.

    Request body:
        {"symbols": [{"symbol": "AAPL", "type": "stock"}, ...], "year": 2025}

    Returns:
        {"year": 2025, "data": {"AAPL": [{"month": 1, "return": 5.2}, ...], ...}}
    """
    body = request.get_json(silent=True) or {}
    symbols = body.get("symbols", [])
    year = body.get("year")

    if not symbols or not year:
        return jsonify({"error": "symbols and year are required"}), 400

    try:
        year = int(year)
    except (ValueError, TypeError):
        return jsonify({"error": "year must be an integer"}), 400

    try:
        result = fetch_monthly_returns_batch(symbols, year)
        return jsonify({"year": year, "data": result})
    except Exception as e:
        logger.exception("Failed to fetch monthly returns batch: %s", e)
        return jsonify({"error": str(e)}), 500


@price_change_bp.route("/daily", methods=["POST"])
def get_daily_returns():
    """Return daily returns for a symbol in a given year and month."""
    body = request.get_json(silent=True) or {}
    symbol = body.get("symbol", "").strip().upper()
    asset_type = body.get("type", "stock").strip().lower()
    year = body.get("year")
    month = body.get("month")

    if not symbol or not year or not month:
        return jsonify({"error": "symbol, year and month are required"}), 400

    try:
        year = int(year)
        month = int(month)
    except (ValueError, TypeError):
        return jsonify({"error": "year and month must be integers"}), 400

    if month < 1 or month > 12:
        return jsonify({"error": "month must be between 1 and 12"}), 400

    try:
        days = fetch_daily_returns(symbol, asset_type, year, month)
        return jsonify({"symbol": symbol, "type": asset_type, "year": year, "month": month, "days": days})
    except Exception as e:
        logger.exception("Failed to fetch daily returns: %s", e)
        return jsonify({"error": str(e)}), 500


@price_change_bp.route("/backtest", methods=["POST"])
def backtest():
    """Run DCA backtest using daily prices."""
    body = request.get_json(silent=True) or {}
    try:
        result = run_dca_backtest(body)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("Failed to run backtest: %s", e)
        return jsonify({"error": str(e)}), 500


@price_change_bp.route("/crash-stats", methods=["POST"])
def crash_stats():
    """Detect single-day crash events and compute recovery metrics.

    Request body:
        {"symbol": "QQQ", "type": "stock", "start_date": "2020-01-01",
         "end_date": "2025-12-31", "threshold_pct": 4.77}
    """
    body = request.get_json(silent=True) or {}
    try:
        result = run_crash_stats(body)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("Failed to run crash stats: %s", e)
        return jsonify({"error": str(e)}), 500


@price_change_bp.route("/crash-chart", methods=["POST"])
def crash_chart():
    """Return daily close prices around a crash event for charting.

    Request body:
        {"symbol": "QQQ", "type": "stock", "pre_crash_date": "2022-05-04",
         "trading_days": 30}
    """
    body = request.get_json(silent=True) or {}
    try:
        result = get_crash_chart_data(body)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("Failed to get crash chart data: %s", e)
        return jsonify({"error": str(e)}), 500


@price_change_bp.route("/leader-breakout", methods=["POST"])
def leader_breakout():
    """Scan 沪深主板 stocks for 连续涨停龙头股回调冲击新高 patterns.

    Long-running request (~2 min for full scan). Results cached 4 hours.
    """
    body = request.get_json(silent=True) or {}
    try:
        result = run_leader_breakout(body)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("Failed to run leader breakout scan: %s", e)
        return jsonify({"error": str(e)}), 500


@price_change_bp.route("/leader-breakout/export", methods=["POST"])
def leader_breakout_export():
    """Export leader breakout results as Excel file."""
    body = request.get_json(silent=True) or {}
    try:
        excel_bytes = export_leader_breakout(body)
        return excel_bytes, 200, {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": "attachment; filename=a_stock_leaders.xlsx",
        }
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("Failed to export leader breakout: %s", e)
        return jsonify({"error": str(e)}), 500


@price_change_bp.route("/vix-comparison", methods=["POST"])
def vix_comparison():
    """Return SPY, QQQ, VIX data aggregated by period.

    Request body:
        {"period": "1hour|daily|weekly|monthly", "count": 30}

    Returns:
        {"spy": [...], "qqq": [...], "vix": [...],
         "latest_vix": float, "meta": {...}}
    """
    import concurrent.futures
    import time as _time
    from datetime import datetime, timezone

    from service.price_change.common import YAHOO_BASE, REQUEST_TIMEOUT, ThreadLocalSession

    body = request.get_json(silent=True) or {}
    period = body.get("period", "daily").strip().lower()
    if period not in ("1hour", "daily", "weekly", "monthly"):
        return jsonify({"error": "period must be 1hour, daily, weekly, or monthly"}), 400

    try:
        count = int(body.get("count", body.get("days", 30)))
    except (ValueError, TypeError):
        count = 30

    # Number of returned chart bars. Keep a bounded range for UI performance.
    if period == "1hour":
        count = max(5, min(count, 240))
    else:
        count = max(5, min(count, 2000))

    # Map period to Yahoo interval
    interval_map = {
        "1hour": "1h",
        "daily": "1d",
        "weekly": "1d",
        "monthly": "1d",
    }
    yahoo_interval = interval_map[period]

    # For intraday periods, fetch directly from Yahoo (bypass daily cache —
    # intraday data changes too fast to cache meaningfully).
    # For daily/weekly/monthly, use the cached daily fetcher.
    symbols = ["SPY", "QQQ", "^VIX"]
    series_map = {}

    def _fetch_intraday(symbol: str) -> dict:
        """Fetch intraday bars from Yahoo Finance. Returns raw bar list."""
        session = ThreadLocalSession()
        session.headers.update({"User-Agent": "Mozilla/5.0"})
        now = int(_time.time())
        # Yahoo requires a recent period1 for intraday intervals (not epoch 0).
        lookback = 60 * 24 * 3600
        period1 = now - lookback
        try:
            resp = session.get(
                f"{YAHOO_BASE}/{symbol}",
                params={
                    "period1": period1,
                    "period2": now,
                    "interval": yahoo_interval,
                },
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.error("Yahoo intraday fetch failed for %s: %s", symbol, e)
            return {"error": str(e)}

        try:
            result = data["chart"]["result"][0]
            timestamps = result["timestamp"]
            quote = result["indicators"]["quote"][0]
            closes = quote.get("close")
            if not closes:
                # Try adjclose
                adjclose = result.get("indicators", {}).get("adjclose")
                if adjclose and adjclose[0].get("adjclose"):
                    closes = adjclose[0]["adjclose"]
            if not closes:
                return {"error": "no close data"}
            return {"timestamps": timestamps, "closes": closes}
        except (KeyError, IndexError, TypeError) as e:
            return {"error": f"parse error: {e}"}

    if period == "1hour":
        # Intraday: fetch directly
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            futures = {executor.submit(_fetch_intraday, sym): sym for sym in symbols}
            for fut in concurrent.futures.as_completed(futures):
                sym = futures[fut]
                try:
                    series_map[sym] = fut.result()
                except Exception as e:
                    logger.exception("Failed to fetch %s: %s", sym, e)
                    series_map[sym] = {"error": str(e)}
    else:
        # Daily/weekly/monthly: use cached fetcher
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(_fetch_daily_series_cached, sym, "stock"): sym
                for sym in symbols
            }
            for fut in concurrent.futures.as_completed(futures):
                sym = futures[fut]
                try:
                    s = fut.result()
                    if s and not s.error:
                        series_map[sym] = {
                            "timestamps": s.timestamps,
                            "closes": s.closes,
                            "source": s.source,
                        }
                    else:
                        series_map[sym] = {"error": s.error if s else "no data"}
                except Exception as e:
                    logger.exception("Failed to fetch %s: %s", sym, e)
                    series_map[sym] = {"error": str(e)}

    def _aggregate(raw, period_type):
        """Aggregate raw data to requested period, returning [{date, close}, ...]."""
        if raw is None or raw.get("error"):
            return []

        timestamps = raw.get("timestamps", [])
        closes = raw.get("closes", [])

        from collections import defaultdict

        # Build (datetime, close) pairs
        pairs = []
        for ts, close in zip(timestamps, closes):
            if close is None:
                continue
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)
            pairs.append((dt, close))

        if not pairs:
            return []

        # Limit to requested data points
        if period_type in ("1hour", "daily"):
            pairs = pairs[-count:]

        if period_type == "1hour":
            # Return raw hourly bars with precise timestamps
            result = []
            for dt, close in pairs:
                result.append({
                    "date": dt.strftime("%Y-%m-%dT%H:%M:%S"),
                    "close": round(close, 2),
                })
            return result

        if period_type == "daily":
            result = []
            for dt, close in pairs:
                result.append({
                    "date": dt.strftime("%Y-%m-%d"),
                    "close": round(close, 2),
                })
            return result

        if period_type == "weekly":
            groups = defaultdict(list)
            for dt, close in pairs:
                iso = dt.isocalendar()
                groups[(iso[0], iso[1])].append((dt, close))
            result = []
            for key in sorted(groups.keys())[-count:]:
                last_dt, last_close = groups[key][-1]
                result.append({
                    "date": last_dt.strftime("%Y-%m-%d"),
                    "close": round(last_close, 2),
                })
            return result

        if period_type == "monthly":
            groups = defaultdict(list)
            for dt, close in pairs:
                groups[(dt.year, dt.month)].append((dt, close))
            result = []
            for key in sorted(groups.keys())[-count:]:
                last_dt, last_close = groups[key][-1]
                result.append({
                    "date": last_dt.strftime("%Y-%m-%d"),
                    "close": round(last_close, 2),
                })
            return result

        return []

    def _valid_closes(raw):
        if not raw or raw.get("error"):
            return []
        return [c for c in raw.get("closes", []) if c is not None]

    def _vix_percentile(raw, lookback: int = 252):
        closes = _valid_closes(raw)
        if len(closes) < 2:
            return None
        window = closes[-lookback:]
        latest = window[-1]
        below_or_equal = sum(1 for c in window if c <= latest)
        return round(below_or_equal / len(window) * 100, 1)

    def _daily_return_map(raw):
        if not raw or raw.get("error"):
            return {}
        items = []
        for ts, close in zip(raw.get("timestamps", []), raw.get("closes", [])):
            if close is None:
                continue
            dt = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
            items.append((dt, close))
        result = {}
        for i in range(1, len(items)):
            prev = items[i - 1][1]
            curr = items[i][1]
            if prev:
                result[items[i][0]] = curr / prev - 1
        return result

    def _spy_vix_correlation(window: int = 30):
        spy_returns = _daily_return_map(series_map.get("SPY"))
        vix_returns = _daily_return_map(series_map.get("^VIX"))
        dates = sorted(set(spy_returns) & set(vix_returns))[-window:]
        if len(dates) < 5:
            return None
        xs = [spy_returns[d] for d in dates]
        ys = [vix_returns[d] for d in dates]
        avg_x = sum(xs) / len(xs)
        avg_y = sum(ys) / len(ys)
        cov = sum((x - avg_x) * (y - avg_y) for x, y in zip(xs, ys))
        var_x = sum((x - avg_x) ** 2 for x in xs)
        var_y = sum((y - avg_y) ** 2 for y in ys)
        if not var_x or not var_y:
            return None
        return round(cov / ((var_x * var_y) ** 0.5), 3)

    result = {
        "spy": _aggregate(series_map.get("SPY"), period),
        "qqq": _aggregate(series_map.get("QQQ"), period),
        "vix": _aggregate(series_map.get("^VIX"), period),
        "period": period,
        "meta": {},
        "stats": {},
    }

    vix_data = series_map.get("^VIX", {})
    valid_vix = _valid_closes(vix_data)
    result["latest_vix"] = round(valid_vix[-1], 2) if valid_vix else None
    result["stats"] = {
        "vix_percentile_1y": _vix_percentile(vix_data, 252),
        "spy_vix_corr_30": _spy_vix_correlation(30) if period != "1hour" else None,
    }

    # Meta: data source and point counts
    for sym in ("SPY", "QQQ", "^VIX"):
        raw = series_map.get(sym, {})
        result["meta"][sym] = {
            "source": raw.get("source", "yahoo"),
            "points": len(raw.get("timestamps", [])),
            "error": raw.get("error"),
        }

    return jsonify(result)
