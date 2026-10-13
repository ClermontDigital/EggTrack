"""The numbers behind Egg Track: totals, averages, lay rate and the series the card draws.

Pure Python, no Home Assistant imports, so it can be tested on its own.

`days` maps an ISO date to that day's record, `{"eggs": 4, ...}`. A day with no record is "not
logged": it counts as zero eggs in a total, but averages don't run past the first or the last day
anyone logged, so a tracker started yesterday isn't averaged over a week, and an egg-less morning
doesn't drag today's average down before the eggs are collected.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, timedelta
from typing import Any

Days = dict[str, dict[str, Any]]


def eggs_on(days: Days, day: date) -> int:
    record = days.get(day.isoformat())
    return int(record.get("eggs", 0)) if record else 0


def is_logged(days: Days, day: date) -> bool:
    return day.isoformat() in days


def total(days: Days, start: date, end: date) -> int:
    """Eggs from `start` to `end`, both included."""
    if end < start:
        return 0
    lo, hi = start.isoformat(), end.isoformat()
    return sum(int(r.get("eggs", 0)) for d, r in days.items() if lo <= d <= hi)


def _logged_dates(days: Days) -> list[date]:
    return sorted(date.fromisoformat(d) for d in days)


@dataclass(frozen=True)
class Stats:
    today: int
    yesterday: int
    last_7_days: int
    last_30_days: int
    this_month: int
    this_year: int
    all_time: int
    daily_average: float | None      # eggs a day over the last 7 days
    average_30: float | None         # ... over the last 30 days
    lay_rate: float | None           # daily_average as a percentage of the hens
    best_eggs: int
    best_day: date | None
    streak: int                      # days in a row with at least one egg
    first_day: date | None
    last_logged: date | None
    days_logged: int
    logged_today: bool

    def as_dict(self) -> dict[str, Any]:
        out = asdict(self)
        for key in ("best_day", "first_day", "last_logged"):
            out[key] = out[key].isoformat() if out[key] else None
        return out


def _average(days: Days, anchor: date, first: date, span: int) -> float | None:
    """Eggs a day over the `span` days ending on `anchor`, not reaching back before `first`."""
    start = max(first, anchor - timedelta(days=span - 1))
    length = (anchor - start).days + 1
    if length <= 0:
        return None
    return round(total(days, start, anchor) / length, 2)


def stats(days: Days, today: date, hens: int = 0) -> Stats:
    logged = [d for d in _logged_dates(days) if d <= today]
    first = logged[0] if logged else None
    last = logged[-1] if logged else None
    logged_today = is_logged(days, today)
    # Averages and the streak end today once today has been logged, otherwise yesterday.
    anchor = today if logged_today else today - timedelta(days=1)

    average = average_30 = None
    if first is not None and first <= anchor:
        average = _average(days, anchor, first, 7)
        average_30 = _average(days, anchor, first, 30)

    streak = 0
    day = anchor
    while eggs_on(days, day) > 0:
        streak += 1
        day -= timedelta(days=1)

    best_day, best_eggs = None, 0
    for d in logged:
        n = eggs_on(days, d)
        if n > best_eggs:      # the earliest day wins a tie
            best_day, best_eggs = d, n

    return Stats(
        today=eggs_on(days, today),
        yesterday=eggs_on(days, today - timedelta(days=1)),
        last_7_days=total(days, today - timedelta(days=6), today),
        last_30_days=total(days, today - timedelta(days=29), today),
        this_month=total(days, today.replace(day=1), today),
        this_year=total(days, today.replace(month=1, day=1), today),
        all_time=total(days, first, today) if first else 0,
        daily_average=average,
        average_30=average_30,
        lay_rate=round(average / hens * 100, 1) if average is not None and hens > 0 else None,
        best_eggs=best_eggs,
        best_day=best_day,
        streak=streak,
        first_day=first,
        last_logged=last,
        days_logged=len(logged),
        logged_today=logged_today,
    )


def series(days: Days, today: date, count: int) -> list[dict[str, Any]]:
    """The last `count` days, oldest first, for the bar chart."""
    out = []
    for back in range(count - 1, -1, -1):
        day = today - timedelta(days=back)
        record = days.get(day.isoformat())
        out.append({"date": day.isoformat(), "eggs": int(record.get("eggs", 0)) if record else 0,
                    "logged": record is not None, "note": (record or {}).get("note", "")})
    return out


def weekly(days: Days, today: date, count: int = 12) -> list[dict[str, Any]]:
    """Totals for the last `count` weeks (Monday to Sunday), oldest first. The last one is this week so far."""
    monday = today - timedelta(days=today.weekday())
    out = []
    for back in range(count - 1, -1, -1):
        start = monday - timedelta(weeks=back)
        out.append({"start": start.isoformat(), "eggs": total(days, start, min(start + timedelta(days=6), today))})
    return out


def monthly(days: Days, today: date, count: int = 12) -> list[dict[str, Any]]:
    """Totals for the last `count` calendar months, oldest first. The last one is this month so far."""
    out = []
    year, month = today.year, today.month
    for _ in range(count):
        start = date(year, month, 1)
        end = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1))
        out.append({"month": f"{year:04d}-{month:02d}", "eggs": total(days, start, min(end, today))})
        year, month = (year - 1, 12) if month == 1 else (year, month - 1)
    return out[::-1]
