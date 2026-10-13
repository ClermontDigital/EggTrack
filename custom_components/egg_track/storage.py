"""Per-flock storage: one record per day, kept in Home Assistant's .storage.

A day is "logged" once it has an egg count, even a count of zero. A day with only a note is not:
writing "broody hen" before the eggs are collected mustn't count as a no-egg day.
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN, MAX_EGGS, MAX_NOTE

STORAGE_VERSION = 1


class InvalidLog(ValueError):
    """Raised when a day update contains something the tracker can't store."""


def check_day(day: date, today: date) -> None:
    """Tomorrow is allowed, to forgive a phone that's a time zone ahead of Home Assistant."""
    if day > today + timedelta(days=1):
        raise InvalidLog("Eggs can't be logged for a day that hasn't happened yet")


class EggStore:
    """Read-change-write is serialised so two people collecting eggs at once can't drop a count."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        self._store = Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry_id}")
        self._lock = asyncio.Lock()
        self.days: dict[str, dict[str, Any]] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.days = data.get("days") or {}

    async def _save(self) -> None:
        await self._store.async_save({"days": self.days})

    async def async_remove(self) -> None:
        await self._store.async_remove()

    def record(self, day: date) -> dict[str, Any]:
        """What the card shows for a day, logged or not."""
        stored = self.days.get(day.isoformat()) or {}
        return {"date": day.isoformat(), "eggs": int(stored.get("eggs", 0)), "note": stored.get("note", ""),
                "logged": "eggs" in stored}

    def _stamp(self, record: dict[str, Any], user_id: str | None) -> None:
        record["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if user_id:
            record["updated_by"] = user_id

    async def async_set(self, day: date, eggs: int | None = None, note: str | None = None,
                        user_id: str | None = None) -> dict[str, Any]:
        """Set a day's count and/or note. Whatever isn't given is left as it was."""
        if eggs is None and note is None:
            raise InvalidLog("Give a count, a note, or both")
        if eggs is not None and not 0 <= eggs <= MAX_EGGS:
            raise InvalidLog(f"Eggs must be between 0 and {MAX_EGGS}")
        if note is not None:
            note = note.strip()
            if len(note) > MAX_NOTE:
                raise InvalidLog(f"Notes can be up to {MAX_NOTE} characters")
        async with self._lock:
            record = dict(self.days.get(day.isoformat()) or {})
            if eggs is not None:
                record["eggs"] = int(eggs)
            if note is not None:
                if note:
                    record["note"] = note
                else:
                    record.pop("note", None)
            if "eggs" in record or "note" in record:
                self._stamp(record, user_id)
                self.days[day.isoformat()] = record
            else:
                self.days.pop(day.isoformat(), None)   # the note was all there was, and it's gone
            await self._save()
        return self.record(day)

    async def async_add(self, day: date, count: int = 1, user_id: str | None = None) -> dict[str, Any]:
        """Add (or, with a negative count, take away) eggs. The count never goes below zero.

        Taking eggs away from a day with no count does nothing: it stays not logged, not a zero.
        """
        count = int(count)
        async with self._lock:
            record = dict(self.days.get(day.isoformat()) or {})
            if count == 0 or (count < 0 and "eggs" not in record):
                return self.record(day)
            eggs = max(0, int(record.get("eggs", 0)) + count)
            if eggs > MAX_EGGS:
                raise InvalidLog(f"Eggs must be between 0 and {MAX_EGGS}")
            record["eggs"] = eggs
            self._stamp(record, user_id)
            self.days[day.isoformat()] = record
            await self._save()
        return self.record(day)

    async def async_clear(self, day: date) -> dict[str, Any]:
        """Forget a day's count and note, so it reads as not logged (different from logging zero eggs)."""
        async with self._lock:
            if self.days.pop(day.isoformat(), None) is not None:
                await self._save()
        return self.record(day)
