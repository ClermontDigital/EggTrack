"""Today's count as a number you can set, for dashboards that don't use the card."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import engine
from .const import MAX_EGGS
from .entity import FlockEntity
from .storage import InvalidLog


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([EggsTodayNumber(hass, entry)])


class EggsTodayNumber(FlockEntity, NumberEntity):
    _attr_icon = "mdi:egg"
    _attr_native_min_value = 0
    _attr_native_max_value = MAX_EGGS
    _attr_native_step = 1
    _attr_mode = NumberMode.BOX
    _attr_native_unit_of_measurement = "eggs"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, entry, "eggs_today_count")

    @property
    def native_value(self) -> float:
        return engine.eggs_on(self.store.days, self.today)

    async def async_set_native_value(self, value: float) -> None:
        try:
            await self.store.async_set(self.today, eggs=int(value), user_id=self._context.user_id if self._context else None)
        except InvalidLog as err:
            raise ServiceValidationError(str(err)) from err
        self.notify_changed()
