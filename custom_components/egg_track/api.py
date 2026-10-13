"""WebSocket API for the Egg Track card.

Anyone signed in to Home Assistant can read and log: eggs are a household job, so there are no
per-person permissions here.
"""
from __future__ import annotations

from datetime import date
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect, async_dispatcher_send
from homeassistant.util import dt as dt_util

from . import engine
from .const import CONF_HENS, DOMAIN, MAX_EGGS, MAX_NOTE, SIGNAL_UPDATED
from .storage import EggStore, InvalidLog, check_day

MAX_CHART_DAYS = 366


def hens_of(entry: ConfigEntry) -> int:
    return int({**entry.data, **entry.options}.get(CONF_HENS) or 0)


def flocks(hass: HomeAssistant) -> list[ConfigEntry]:
    """Loaded flocks, in the order they were added."""
    return [e for e in hass.config_entries.async_entries(DOMAIN) if e.entry_id in hass.data.get(DOMAIN, {})]


def store_of(hass: HomeAssistant, entry_id: str) -> EggStore:
    return hass.data[DOMAIN][entry_id]["store"]


@callback
def changed(hass: HomeAssistant, entry_id: str) -> None:
    """Tell the sensors and every open card that this flock's log changed."""
    async_dispatcher_send(hass, SIGNAL_UPDATED.format(entry_id))


def _resolve(hass: HomeAssistant, connection: websocket_api.ActiveConnection,
             msg: dict[str, Any]) -> tuple[ConfigEntry, EggStore] | None:
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if not entry or entry.domain != DOMAIN or entry.entry_id not in hass.data.get(DOMAIN, {}):
        connection.send_error(msg["id"], "not_found", "No such flock")
        return None
    return entry, store_of(hass, entry.entry_id)


def _day(msg: dict[str, Any], today: date) -> date:
    return date.fromisoformat(msg["date"]) if msg.get("date") else today


def _iso_date(value: Any) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except (TypeError, ValueError) as err:
        raise vol.Invalid("Dates look like 2026-10-13") from err


def overview(entry: ConfigEntry, store: EggStore, today: date, chart_days: int, day: date | None = None) -> dict[str, Any]:
    hens = hens_of(entry)
    return {
        "flock": {"entry_id": entry.entry_id, "name": entry.title, "hens": hens},
        "today": today.isoformat(),
        "day": store.record(day or today),
        "stats": engine.stats(store.days, today, hens).as_dict(),
        "series": engine.series(store.days, today, chart_days),
        "weeks": engine.weekly(store.days, today),
        "months": engine.monthly(store.days, today),
    }


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/flocks"})
@callback
def ws_flocks(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    connection.send_result(msg["id"], [
        {"entry_id": e.entry_id, "name": e.title, "hens": hens_of(e)} for e in flocks(hass)])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/overview",
    vol.Required("entry_id"): str,
    vol.Optional("date"): _iso_date,
    vol.Optional("days", default=14): vol.All(vol.Coerce(int), vol.Range(min=1, max=MAX_CHART_DAYS)),
})
@callback
def ws_overview(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Everything the card needs. `date` is the day being looked at; today when left out."""
    if not (found := _resolve(hass, connection, msg)):
        return
    entry, store = found
    today = dt_util.now().date()
    connection.send_result(msg["id"], overview(entry, store, today, msg["days"], _day(msg, today)))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/days",
    vol.Required("entry_id"): str,
    vol.Optional("start"): _iso_date,
    vol.Optional("end"): _iso_date,
})
@callback
def ws_days(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The logged days in a range (everything when no range is given), for the calendar and the CSV export."""
    if not (found := _resolve(hass, connection, msg)):
        return
    _, store = found
    start, end = msg.get("start", ""), msg.get("end", "9999-12-31")
    connection.send_result(msg["id"], {
        d: {"eggs": int(r.get("eggs", 0)), "note": r.get("note", "")}
        for d, r in sorted(store.days.items()) if start <= d <= end})


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/add",
    vol.Required("entry_id"): str,
    vol.Optional("date"): _iso_date,
    vol.Optional("count", default=1): vol.All(vol.Coerce(int), vol.Range(min=-MAX_EGGS, max=MAX_EGGS)),
})
@websocket_api.async_response
async def ws_add(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if not (found := _resolve(hass, connection, msg)):
        return
    entry, store = found
    today = dt_util.now().date()
    try:
        day = _day(msg, today)
        check_day(day, today)
        record = await store.async_add(day, msg["count"], connection.user.id)
    except InvalidLog as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    changed(hass, entry.entry_id)
    connection.send_result(msg["id"], record)


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/set_day",
    vol.Required("entry_id"): str,
    vol.Optional("date"): _iso_date,
    vol.Optional("eggs"): vol.All(vol.Coerce(int), vol.Range(min=0, max=MAX_EGGS)),
    vol.Optional("note"): vol.All(str, vol.Length(max=MAX_NOTE * 4)),
})
@websocket_api.async_response
async def ws_set_day(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if not (found := _resolve(hass, connection, msg)):
        return
    entry, store = found
    today = dt_util.now().date()
    try:
        day = _day(msg, today)
        check_day(day, today)
        record = await store.async_set(day, msg.get("eggs"), msg.get("note"), connection.user.id)
    except InvalidLog as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    changed(hass, entry.entry_id)
    connection.send_result(msg["id"], record)


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/clear_day",
    vol.Required("entry_id"): str,
    vol.Required("date"): _iso_date,
})
@websocket_api.async_response
async def ws_clear_day(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Forget a day, so it reads as not logged."""
    if not (found := _resolve(hass, connection, msg)):
        return
    entry, store = found
    record = await store.async_clear(date.fromisoformat(msg["date"]))
    changed(hass, entry.entry_id)
    connection.send_result(msg["id"], record)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe", vol.Required("entry_id"): str})
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """An event every time this flock's log changes (and at midnight), so open cards stay in step."""
    if not _resolve(hass, connection, msg):
        return

    @callback
    def _forward() -> None:
        connection.send_message(websocket_api.event_message(msg["id"], {"changed": True}))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(
        hass, SIGNAL_UPDATED.format(msg["entry_id"]), _forward)
    connection.send_result(msg["id"])


@callback
def async_register_api(hass: HomeAssistant) -> None:
    for command in (ws_flocks, ws_overview, ws_days, ws_add, ws_set_day, ws_clear_day, ws_subscribe):
        websocket_api.async_register_command(hass, command)
