"""Config flow: one entry per flock."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import CONF_HENS, CONF_NAME, DEFAULT_NAME, DOMAIN, MAX_HENS


def _hens() -> selector.NumberSelector:
    return selector.NumberSelector(selector.NumberSelectorConfig(
        min=0, max=MAX_HENS, step=1, mode=selector.NumberSelectorMode.BOX))


class EggTrackConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            name = user_input[CONF_NAME].strip()
            if not name:
                errors[CONF_NAME] = "name_required"
            elif any(e.title.casefold() == name.casefold() for e in self._async_current_entries()):
                errors[CONF_NAME] = "name_taken"
            else:
                return self.async_create_entry(
                    title=name, data={CONF_NAME: name}, options={CONF_HENS: int(user_input.get(CONF_HENS) or 0)})
        schema = vol.Schema({
            vol.Required(CONF_NAME, default=(user_input or {}).get(CONF_NAME, DEFAULT_NAME)): str,
            vol.Optional(CONF_HENS, default=(user_input or {}).get(CONF_HENS, 0)): _hens(),
        })
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return EggTrackOptionsFlow()


class EggTrackOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data={CONF_HENS: int(user_input.get(CONF_HENS) or 0)})
        current = int(self.config_entry.options.get(CONF_HENS) or 0)
        return self.async_show_form(
            step_id="init", data_schema=vol.Schema({vol.Optional(CONF_HENS, default=current): _hens()}))
