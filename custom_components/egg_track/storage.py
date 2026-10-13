"""Per-flock storage: one record per day, kept in Home Assistant's .storage."""
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
        stored = self.days.get(day.isoformat())
        return {"date": day.isoformat(), "eggs": int(stored.get("eggs", 0)) if stored else 0,
                "note": (stored or {}).get("note", ""), "logged": stored is not None}

    def _stamp(self, record: dict[str, Any], user_id: str | None) -> None:
        record["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if user_id:
            record["updated_by"] = user_id

    async def async_set(self, day: date, eggs: int | None = None, note: str | None = None,
                        user_id: str | None = None) -> dict[str, Any]:
        """Set a day's count and/or note. Whatever isn't given is left as it was."""
        if eggs is not None and not 0 <= eggs <= MAX_EGGS:
            raise InvalidLog(f"Eggs must be between 0 and {MAX_EGGS}")
        if note is not None:
            note = note.strip()
            if len(note) > MAX_NOTE:
                raise InvalidLog(f"Notes can be up to {MAX_NOTE} characters")
        async with self._lock:
            record = dict(self.days.get(day.isoformat()) or {"eggs": 0})
            if eggs is not None:
                record["eggs"] = int(eggs)
            if note is not None:
                if note:
                    record["note"] = note
                else:
                    record.pop("note", None)
            self._stamp(record, user_id)
            self.days[day.isoformat()] = record
            await self._save()
        return self.record(day)

    async def async_add(self, day: date, count: int = 1, user_id: str | None = None) -> dict[str, Any]:
        """Add (or, with a negative count, take away) eggs. The count never goes below zero."""
        async with self._lock:
            record = dict(self.days.get(day.isoformat()) or {"eggs": 0})
            eggs = max(0, int(record.get("eggs", 0)) + int(count))
            if eggs > MAX_EGGS:
                raise InvalidLog(f"Eggs must be between 0 and {MAX_EGGS}")
            record["eggs"] = eggs
            self._stamp(record, user_id)
            self.days[day.isoformat()] = record
            await self._save()
        return self.record(day)

    async def async_clear(self, day: date) -> dict[str, Any]:
        """Forget a day, so it reads as not logged (different from logging zero eggs)."""
        async with self._lock:
            if self.days.pop(day.isoformat(), None) is not None:
                await self._save()
        return self.record(day)
