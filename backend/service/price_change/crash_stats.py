"""Crash detection and recovery analysis.

Finds single-day drops exceeding a threshold and calculates how many
trading days it took to recover to the pre-crash closing price.
"""

from datetime import date, datetime, timezone
from typing import Dict, List, Optional, Tuple


def compute_crash_statistics(
    timestamps: List[int],
    closes: List[Optional[float]],
    start_date: date,
    end_date: date,
    threshold_pct: float,
) -> List[Dict]:
    """Find crash events and their recovery metrics.

    A "crash" is defined as a single-day drop >= threshold_pct (in absolute terms).
    Recovery is measured by the number of trading days until the close price
    reaches or exceeds the pre-crash close price.

    Args:
        timestamps: Unix epoch seconds for each trading day.
        closes: Close prices aligned with timestamps.
        start_date: Only consider crashes on or after this date.
        end_date: Only consider crashes on or before this date.
        threshold_pct: Positive number (e.g. 4.77 means drop >= -4.77%).

    Returns:
        List of crash event dicts, each with:
        - crash_date: ISO date string of the crash day
        - pre_crash_date: ISO date string of the previous trading day
        - pre_crash_close: close price before the drop
        - crash_close: close price on the crash day
        - drop_pct: percentage drop (negative number)
        - recovery_date: ISO date string of recovery day, or None if not recovered
        - recovery_days: number of trading days to recover, or None
        - recovered: bool indicating whether price recovered by end_date
    """
    # Build a list of (date, close) for the full series
    points: List[Tuple[date, float]] = []
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        dt = datetime.fromtimestamp(ts, tz=timezone.utc).date()
        points.append((dt, float(close)))

    if len(points) < 2:
        return []

    # Pre-compute daily returns: return[i] = points[i].close / points[i-1].close - 1
    results: List[Dict] = []

    for i in range(1, len(points)):
        prev_date, prev_close = points[i - 1]
        cur_date, cur_close = points[i]

        if cur_date < start_date or cur_date > end_date:
            continue

        daily_return_pct = (cur_close / prev_close - 1) * 100
        if daily_return_pct > -threshold_pct:
            continue  # not a crash

        # This is a crash. Now find recovery.
        recovery_date: Optional[date] = None
        recovery_days: Optional[int] = None
        recovered = False

        for j in range(i + 1, len(points)):
            check_date, check_close = points[j]
            if check_close >= prev_close:
                recovery_date = check_date
                recovered = True
                break
            if check_date > end_date:
                break

        if recovered and recovery_date is not None:
            # Count trading days: from crash day (exclusive) to recovery day (inclusive)
            trading_days = 0
            for j in range(i + 1, len(points)):
                trading_days += 1
                if points[j][0] >= recovery_date:
                    break
            recovery_days = trading_days

        results.append({
            "crash_date": cur_date.isoformat(),
            "pre_crash_date": prev_date.isoformat(),
            "pre_crash_close": round(prev_close, 6),
            "crash_close": round(cur_close, 6),
            "drop_pct": round(daily_return_pct, 2),
            "recovery_date": recovery_date.isoformat() if recovery_date else None,
            "recovery_days": recovery_days,
            "recovered": recovered,
        })

    return results
