"""The numbers: totals, averages, lay rate, streak and the chart series."""
from datetime import date, timedelta

from custom_components.egg_track import engine

TODAY = date(2026, 10, 13)   # a Tuesday


def log(counts: dict[int, int]) -> dict:
    """{days ago: eggs} -> the stored shape."""
    return {(TODAY - timedelta(days=back)).isoformat(): {"eggs": n} for back, n in counts.items()}


def test_empty_log():
    s = engine.stats({}, TODAY, hens=6)
    assert (s.today, s.all_time, s.streak, s.days_logged) == (0, 0, 0, 0)
    assert s.daily_average is None and s.lay_rate is None and s.best_day is None and s.last_logged is None
    assert not s.logged_today


def test_totals():
    days = log({0: 4, 1: 5, 2: 3, 6: 2, 7: 6, 29: 1, 30: 9})
    s = engine.stats(days, TODAY)
    assert (s.today, s.yesterday) == (4, 5)
    assert s.last_7_days == 4 + 5 + 3 + 2          # today and the six days before
    assert s.last_30_days == 4 + 5 + 3 + 2 + 6 + 1
    assert s.this_month == 4 + 5 + 3 + 2 + 6       # 1-13 Oct; 29 and 30 days ago are in September
    assert s.all_time == 30 and s.days_logged == 7
    assert s.first_day == TODAY - timedelta(days=30) and s.last_logged == TODAY


def test_this_year_stops_at_new_year():
    days = {"2025-12-31": {"eggs": 7}, "2026-01-01": {"eggs": 3}, "2026-10-13": {"eggs": 2}}
    assert engine.stats(days, TODAY).this_year == 5


def test_average_waits_for_today_to_be_logged():
    """Before the eggs are collected, today isn't a zero-egg day yet."""
    days = log({1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4})
    morning = engine.stats(days, TODAY, hens=8)
    assert not morning.logged_today and morning.daily_average == 4.0 and morning.lay_rate == 50.0
    evening = engine.stats({**days, **log({0: 0})}, TODAY, hens=8)
    assert evening.logged_today and evening.daily_average == round(24 / 7, 2)


def test_average_does_not_reach_back_before_the_first_log():
    s = engine.stats(log({0: 6, 1: 4}), TODAY, hens=10)
    assert s.daily_average == 5.0 and s.average_30 == 5.0 and s.lay_rate == 50.0


def test_unlogged_days_inside_the_window_count_as_zero():
    s = engine.stats(log({0: 7, 6: 7}), TODAY)
    assert s.daily_average == 2.0


def test_no_lay_rate_without_a_hen_count():
    assert engine.stats(log({0: 3}), TODAY, hens=0).lay_rate is None


def test_streak():
    assert engine.stats(log({0: 2, 1: 1, 2: 3, 3: 0, 4: 5}), TODAY).streak == 3
    assert engine.stats(log({1: 1, 2: 3}), TODAY).streak == 2      # today not logged yet: counts to yesterday
    assert engine.stats(log({0: 0, 1: 4}), TODAY).streak == 0      # a logged zero breaks it


def test_best_day_prefers_the_earliest_on_a_tie():
    s = engine.stats(log({0: 6, 3: 6, 5: 2}), TODAY)
    assert s.best_eggs == 6 and s.best_day == TODAY - timedelta(days=3)


def test_future_records_are_ignored_by_stats():
    days = {**log({0: 2}), (TODAY + timedelta(days=1)).isoformat(): {"eggs": 9}}
    s = engine.stats(days, TODAY)
    assert s.all_time == 2 and s.last_logged == TODAY and s.best_eggs == 2


def test_series_is_oldest_first_and_marks_unlogged_days():
    rows = engine.series({**log({0: 4, 2: 0}), (TODAY - timedelta(days=1)).isoformat(): {"eggs": 3, "note": "broody"}}, TODAY, 4)
    assert [r["date"] for r in rows] == [(TODAY - timedelta(days=b)).isoformat() for b in (3, 2, 1, 0)]
    assert [r["eggs"] for r in rows] == [0, 0, 3, 4]
    assert [r["logged"] for r in rows] == [False, True, True, True]
    assert rows[2]["note"] == "broody"


def test_weekly_runs_monday_to_sunday():
    # 13 Oct 2026 is a Tuesday: this week is Mon 12 and Tue 13.
    weeks = engine.weekly(log({0: 4, 1: 5, 2: 3, 8: 6}), TODAY, 3)
    assert [w["start"] for w in weeks] == ["2026-09-28", "2026-10-05", "2026-10-12"]
    assert [w["eggs"] for w in weeks] == [0, 3 + 6, 4 + 5]


def test_monthly_crosses_a_year():
    days = {"2025-12-31": {"eggs": 7}, "2026-01-01": {"eggs": 3}, "2026-02-28": {"eggs": 2}}
    months = engine.monthly(days, date(2026, 2, 28), 3)
    assert months == [{"month": "2025-12", "eggs": 7}, {"month": "2026-01", "eggs": 3}, {"month": "2026-02", "eggs": 2}]


def test_stats_as_dict_is_json_ready():
    out = engine.stats(log({0: 2}), TODAY, hens=4).as_dict()
    assert out["best_day"] == TODAY.isoformat() and out["first_day"] == TODAY.isoformat()
    assert out["lay_rate"] == 50.0 and out["logged_today"] is True


def test_card_and_manifest_versions_match():
    """The card logs its version to the browser console; it should be the integration's."""
    import json
    import re
    from pathlib import Path

    root = Path(engine.__file__).parent
    manifest = json.loads((root / "manifest.json").read_text())
    card = re.search(r'const ET_VERSION = "([^"]+)"', (root / "www" / "egg-track-card.js").read_text())
    assert card and card.group(1) == manifest["version"]


def test_a_note_on_its_own_does_not_log_the_day():
    week = log({1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4})
    with_note = {**week, TODAY.isoformat(): {"note": "Broody hen"}}
    before, after = engine.stats(week, TODAY, hens=8), engine.stats(with_note, TODAY, hens=8)
    assert after == before                       # average 4.0, streak 7, last logged yesterday
    assert not after.logged_today and after.last_logged == TODAY - timedelta(days=1)
    assert not engine.is_logged(with_note, TODAY)
    row = engine.series(with_note, TODAY, 1)[0]
    assert row == {"date": TODAY.isoformat(), "eggs": 0, "logged": False, "note": "Broody hen"}


def test_paused_days_run_from_start_to_end_and_an_open_pause_to_today():
    periods = [{"start": "2026-10-01", "end": "2026-10-03"}, {"start": "2026-10-12", "end": None}]
    assert engine.paused_days(periods, TODAY) == frozenset(
        {date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 3), date(2026, 10, 12), date(2026, 10, 13)})
    assert engine.paused_days([], TODAY) == frozenset()


def test_paused_days_are_left_out_of_the_averages():
    """A week away with nothing collected: the average is the 7 days before it, not dragged down to zero."""
    days = log({0: 4, **{back: 4 for back in range(8, 20)}})        # 1-7 days ago: nothing logged
    paused = frozenset(TODAY - timedelta(days=back) for back in range(1, 8))
    away = engine.stats(days, TODAY, hens=8, paused=paused)
    assert away.daily_average == 4.0 and away.lay_rate == 50.0
    assert engine.stats(days, TODAY, hens=8).daily_average == round(4 / 7, 2)   # without the pause
    assert not away.paused and engine.stats(days, TODAY, paused=frozenset({TODAY})).paused


def test_a_pause_neither_adds_to_nor_breaks_the_streak():
    days = log({0: 3, 4: 2, 5: 1})                                  # 1-3 days ago away, nothing logged
    paused = frozenset(TODAY - timedelta(days=back) for back in (1, 2, 3))
    assert engine.stats(days, TODAY, paused=paused).streak == 3
    assert engine.stats(days, TODAY).streak == 1


def test_eggs_on_paused_days_still_count_in_the_totals():
    days = log({0: 2, 1: 10, 2: 2})                                 # 10 collected the day you got back
    s = engine.stats(days, TODAY, paused=frozenset({TODAY - timedelta(days=1)}))
    assert s.last_7_days == 14 and s.all_time == 14
    assert s.daily_average == 2.0                                   # today and 2 days ago; yesterday skipped
