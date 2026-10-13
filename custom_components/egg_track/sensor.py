"""Sensors for dashboards, graphs and automations."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import engine
from .entity import FlockEntity

EGGS = "eggs"
EGGS_PER_DAY = "eggs/day"


@dataclass(frozen=True)
class SensorSpec:
    key: str
    value: Callable[[engine.Stats], Any]
    unit: str | None = EGGS
    icon: str = "mdi:egg"
    state_class: SensorStateClass | None = SensorStateClass.MEASUREMENT
    device_class: SensorDeviceClass | None = None
    precision: int | None = 0


SPECS = [
    SensorSpec("eggs_today", lambda s: s.today),
    SensorSpec("eggs_yesterday", lambda s: s.yesterday, icon="mdi:egg-outline"),
    SensorSpec("eggs_last_7_days", lambda s: s.last_7_days, icon="mdi:calendar-week"),
    SensorSpec("eggs_this_month", lambda s: s.this_month, icon="mdi:calendar-month"),
    # A running total, so Home Assistant's long-term statistics can chart eggs per day, week or month.
    SensorSpec("eggs_total", lambda s: s.all_time, icon="mdi:egg-fried", state_class=SensorStateClass.TOTAL),
    SensorSpec("daily_average", lambda s: s.daily_average, unit=EGGS_PER_DAY, icon="mdi:chart-line", precision=1),
    SensorSpec("lay_rate", lambda s: s.lay_rate, unit=PERCENTAGE, icon="mdi:percent-outline", precision=0),
    SensorSpec("last_logged", lambda s: s.last_logged, unit=None, icon="mdi:calendar-check",
               state_class=None, device_class=SensorDeviceClass.DATE, precision=None),
]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities(FlockSensor(hass, entry, spec) for spec in SPECS)


class FlockSensor(FlockEntity, SensorEntity):
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, spec: SensorSpec) -> None:
        super().__init__(hass, entry, spec.key)
        self._spec = spec
        self._attr_native_unit_of_measurement = spec.unit
        self._attr_icon = spec.icon
        self._attr_state_class = spec.state_class
        self._attr_device_class = spec.device_class
        if spec.precision is not None:
            self._attr_suggested_display_precision = spec.precision

    @property
    def native_value(self) -> Any:
        return self._spec.value(self.stats())
