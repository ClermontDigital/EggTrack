"""Sensors, the number, the buttons and the services."""
from datetime import timedelta

import pytest

from custom_components.egg_track.const import DOMAIN
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.util import dt as dt_util

from .test_api import setup_flock


def state(hass: HomeAssistant, entity_id: str) -> str:
    found = hass.states.get(entity_id)
    assert found is not None, f"{entity_id} is missing; have {sorted(hass.states.async_entity_ids())}"
    return found.state


async def test_sensors_follow_the_log(hass):
    entry = await setup_flock(hass, "Chickens", 8)
    assert state(hass, "sensor.chickens_eggs_today") == "0"
    assert state(hass, "sensor.chickens_daily_average") == "unknown"
    assert state(hass, "sensor.chickens_last_logged") == "unknown"

    today = dt_util.now().date()
    store = hass.data[DOMAIN][entry.entry_id]["store"]
    await store.async_set(today - timedelta(days=1), eggs=6)
    await hass.services.async_call(DOMAIN, "add_eggs", {"count": 4}, blocking=True)
    await hass.async_block_till_done()

    assert state(hass, "sensor.chickens_eggs_today") == "4"
    assert state(hass, "sensor.chickens_eggs_yesterday") == "6"
    assert state(hass, "sensor.chickens_eggs_last_7_days") == "10"
    assert state(hass, "sensor.chickens_eggs_total") == "10"
    assert state(hass, "sensor.chickens_daily_average") == "5.0"
    assert float(state(hass, "sensor.chickens_lay_rate")) == 62.5
    assert state(hass, "sensor.chickens_last_logged") == today.isoformat()
    assert hass.states.get("sensor.chickens_eggs_total").attributes["state_class"] == "total"
    assert hass.states.get("sensor.chickens_eggs_today").attributes["unit_of_measurement"] == "eggs"


async def test_number_and_buttons(hass):
    entry = await setup_flock(hass)
    await hass.services.async_call("button", "press", {"entity_id": "button.chickens_add_egg"}, blocking=True)
    await hass.services.async_call("button", "press", {"entity_id": "button.chickens_add_egg"}, blocking=True)
    await hass.async_block_till_done()
    assert state(hass, "number.chickens_eggs_today") == "2"
    assert state(hass, "sensor.chickens_eggs_today") == "2"

    await hass.services.async_call("number", "set_value", {"entity_id": "number.chickens_eggs_today", "value": 7}, blocking=True)
    await hass.async_block_till_done()
    assert state(hass, "sensor.chickens_eggs_today") == "7"

    for _ in range(9):   # more presses than eggs: stops at zero
        await hass.services.async_call("button", "press", {"entity_id": "button.chickens_remove_egg"}, blocking=True)
    await hass.async_block_till_done()
    assert state(hass, "number.chickens_eggs_today") == "0"
    assert hass.data[DOMAIN][entry.entry_id]["store"].days[dt_util.now().date().isoformat()]["eggs"] == 0


async def test_services(hass):
    entry = await setup_flock(hass)
    today = dt_util.now().date()
    yesterday = today - timedelta(days=1)
    store = hass.data[DOMAIN][entry.entry_id]["store"]

    await hass.services.async_call(DOMAIN, "set_eggs", {"eggs": 5, "date": yesterday.isoformat(), "note": "Late lay"}, blocking=True)
    await hass.services.async_call(DOMAIN, "add_eggs", {"date": yesterday.isoformat(), "count": -2}, blocking=True)
    await hass.services.async_call(DOMAIN, "add_eggs", {"entry_id": entry.entry_id}, blocking=True)
    assert store.record(yesterday) == {"date": yesterday.isoformat(), "eggs": 3, "note": "Late lay", "logged": True}
    assert store.record(today)["eggs"] == 1

    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "add_eggs", {"date": (today + timedelta(days=5)).isoformat()}, blocking=True)
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "add_eggs", {"entry_id": "not-a-flock"}, blocking=True)


async def test_services_need_a_flock_named_when_there_are_two(hass):
    hens = await setup_flock(hass, "Hens")
    await setup_flock(hass, "Ducks")
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "add_eggs", {}, blocking=True)
    await hass.services.async_call(DOMAIN, "add_eggs", {"entry_id": hens.entry_id, "count": 2}, blocking=True)
    await hass.async_block_till_done()
    assert state(hass, "sensor.hens_eggs_today") == "2"
    assert state(hass, "sensor.ducks_eggs_today") == "0"


async def test_hen_count_change_updates_the_lay_rate(hass):
    entry = await setup_flock(hass, "Chickens", 4)
    await hass.services.async_call(DOMAIN, "set_eggs", {"eggs": 2}, blocking=True)
    await hass.async_block_till_done()
    assert float(state(hass, "sensor.chickens_lay_rate")) == 50.0
    hass.config_entries.async_update_entry(entry, options={"hens": 8})
    await hass.async_block_till_done()
    assert float(state(hass, "sensor.chickens_lay_rate")) == 25.0
    hass.config_entries.async_update_entry(entry, options={"hens": 0})
    await hass.async_block_till_done()
    assert state(hass, "sensor.chickens_lay_rate") == "unknown"


async def test_unload_and_reload_keeps_the_log(hass):
    entry = await setup_flock(hass)
    await hass.services.async_call(DOMAIN, "set_eggs", {"eggs": 3}, blocking=True)
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert state(hass, "sensor.chickens_eggs_today") == "3"
