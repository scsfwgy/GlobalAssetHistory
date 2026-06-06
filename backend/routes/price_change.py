"""
Yearly price change API blueprint.
"""
import logging

from flask import Blueprint, jsonify, request

from service.price_change.price_change_service import (
    fetch_daily_returns,
    fetch_yearly_returns,
    fetch_monthly_returns,
    fetch_monthly_returns_batch,
    get_presets,
    get_color_range,
    run_dca_backtest,
    run_crash_stats,
    get_crash_chart_data,
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
