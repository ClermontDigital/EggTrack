"""egg_track.add_eggs / set_eggs, for automations and scripts."""
from __future__ import annotations

from datetime import date

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.util import dt as dt_util

from .api import changed, flocks, store_of
from .const import (
    ATTR_COUNT, ATTR_DATE, ATTR_EGGS, ATTR_ENTRY_ID, ATTR_NOTE, DOMAIN, MAX_EGGS, MAX_NOTE, SERVICE_ADD_EGGS,
    SERVICE_SET_EGGS,
)
from .storage import InvalidLog, check_day

ADD_SCHEMA = vol.Schema({
    vol.Optional(ATTR_ENTRY_ID): cv.string,
    vol.Optional(ATTR_COUNT, default=1): vol.All(vol.Coerce(int), vol.Range(min=-MAX_EGGS, max=MAX_EGGS)),
    vol.Optional(ATTR_DATE): cv.date,
})
SET_SCHEMA = vol.Schema({
    vol.Optional(ATTR_ENTRY_ID): cv.string,
    vol.Required(ATTR_EGGS): vol.All(vol.Coerce(int), vol.Range(min=0, max=MAX_EGGS)),
    vol.Optional(ATTR_DATE): cv.date,
    vol.Optional(ATTR_NOTE): vol.All(cv.string, vol.Length(max=MAX_NOTE)),
})


def _flock(hass: HomeAssistant, call: ServiceCall) -> str:
    """The flock the call is for: the one named, or the only one there is."""
    loaded = flocks(hass)
    if entry_id := call.data.get(ATTR_ENTRY_ID):
        if entry_id not in {e.entry_id for e in loaded}:
            raise ServiceValidationError("That flock isn't set up in Egg Track")
        return entry_id
    if len(loaded) == 1:
        return loaded[0].entry_id
    raise ServiceValidationError(
        "Choose a flock: there is more than one" if loaded else "Add a flock to Egg Track first")


def _day(call: ServiceCall, today: date) -> date:
    day = call.data.get(ATTR_DATE) or today
    try:
        check_day(day, today)
    except InvalidLog as err:
        raise ServiceValidationError(str(err)) from err
    return day


@callback
def async_register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, SERVICE_ADD_EGGS):
        return

    async def add_eggs(call: ServiceCall) -> None:
        entry_id = _flock(hass, call)
        try:
            await store_of(hass, entry_id).async_add(
                _day(call, dt_util.now().date()), call.data[ATTR_COUNT], call.context.user_id)
        except InvalidLog as err:
            raise ServiceValidationError(str(err)) from err
        changed(hass, entry_id)

    async def set_eggs(call: ServiceCall) -> None:
        entry_id = _flock(hass, call)
        try:
            await store_of(hass, entry_id).async_set(
                _day(call, dt_util.now().date()), call.data[ATTR_EGGS], call.data.get(ATTR_NOTE), call.context.user_id)
        except InvalidLog as err:
            raise ServiceValidationError(str(err)) from err
        changed(hass, entry_id)

    hass.services.async_register(DOMAIN, SERVICE_ADD_EGGS, add_eggs, schema=ADD_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_SET_EGGS, set_eggs, schema=SET_SCHEMA)
