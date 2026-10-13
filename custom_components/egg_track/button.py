"""One-press logging: handy for a dashboard button, an NFC tag in the coop or a voice command."""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import FlockEntity
from .storage import InvalidLog


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([
        EggButton(hass, entry, "add_egg", 1, "mdi:egg-outline"),
        EggButton(hass, entry, "remove_egg", -1, "mdi:egg-off-outline"),
    ])


class EggButton(FlockEntity, ButtonEntity):
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, key: str, count: int, icon: str) -> None:
        super().__init__(hass, entry, key)
        self._count = count
        self._attr_icon = icon

    async def async_press(self) -> None:
        try:
            await self.store.async_add(self.today, self._count, self._context.user_id if self._context else None)
        except InvalidLog as err:
            raise ServiceValidationError(str(err)) from err
        self.notify_changed()
