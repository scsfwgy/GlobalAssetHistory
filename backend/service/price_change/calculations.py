"""Return calculations and backtest helpers."""

from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

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


def _compute_money_weighted_annualized_return(
    cashflows: List[Tuple[date, float]],
    final_date: date,
    final_value: float,
) -> Optional[float]:
    """Compute XIRR-style annualized return for dated investment cash flows.

    Cash flows use the investor perspective: contributions are negative, and
    the final market value is a positive terminal cash flow. This is the right
    annualized metric for DCA because each contribution only earns returns for
    the time it is actually invested.
    """
    if final_value <= 0:
        return None

    dated_flows = [(flow_date, amount) for flow_date, amount in cashflows if amount]
    if not dated_flows:
        return None
    dated_flows.append((final_date, final_value))

    first_date = min(flow_date for flow_date, _ in dated_flows)
    if max((flow_date - first_date).days for flow_date, _ in dated_flows) <= 0:
        return None

    has_positive = any(amount > 0 for _, amount in dated_flows)
    has_negative = any(amount < 0 for _, amount in dated_flows)
    if not has_positive or not has_negative:
        return None

    def xnpv(rate: float) -> float:
        base = 1 + rate
        return sum(
            amount / (base ** ((flow_date - first_date).days / 365.0))
            for flow_date, amount in dated_flows
        )

    low = -0.999999
    high = 1.0
    low_val = xnpv(low)
    high_val = xnpv(high)

    # Expand the upper bound until it brackets the root. Conventional DCA cash
    # flows are monotonic, so bisection is stable once signs differ.
    for _ in range(64):
        if low_val == 0:
            return low
        if high_val == 0:
            return high
        if low_val * high_val < 0:
            break
        high *= 2
        high_val = xnpv(high)
    else:
        return None

    for _ in range(100):
        mid = (low + high) / 2
        mid_val = xnpv(mid)
        if abs(mid_val) < 1e-7:
            return mid
        if low_val * mid_val <= 0:
            high = mid
            high_val = mid_val
        else:
            low = mid
            low_val = mid_val

    return (low + high) / 2



def _normalize_frequency(frequency: str) -> str:
    clean = (frequency or "monthly").strip().lower()
    if clean not in {"once", "daily", "weekly", "monthly", "yearly"}:
        raise ValueError("frequency must be one of once, daily, weekly, monthly, yearly")
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

    if frequency == "yearly":
        current = start_date
        while current <= end_date:
            schedule.append(current)
            target_year = current.year + interval
            try:
                current = date(target_year, current.month, current.day)
            except ValueError:
                # Leap day → clamp to last day of month in non-leap year
                import calendar as _cal
                last_day = _cal.monthrange(target_year, current.month)[1]
                current = date(target_year, current.month, last_day)
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

