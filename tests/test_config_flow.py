"""Adding a flock and changing its hen count."""
from custom_components.egg_track.const import DOMAIN
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType


async def test_add_a_flock(hass):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM and result["step_id"] == "user"

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"name": "  Backyard hens ", "hens": 6})
    await hass.async_block_till_done()
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Backyard hens"
    assert result["data"] == {"name": "Backyard hens"} and result["options"] == {"hens": 6}
    assert hass.states.get("sensor.backyard_hens_eggs_today").state == "0"


async def test_names_must_be_given_and_unique(hass):
    first = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    await hass.config_entries.flow.async_configure(first["flow_id"], {"name": "Hens"})
    await hass.async_block_till_done()

    flow = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    blank = await hass.config_entries.flow.async_configure(flow["flow_id"], {"name": "   "})
    assert blank["type"] is FlowResultType.FORM and blank["errors"] == {"name": "name_required"}
    taken = await hass.config_entries.flow.async_configure(flow["flow_id"], {"name": "hens"})
    assert taken["type"] is FlowResultType.FORM and taken["errors"] == {"name": "name_taken"}
    ok = await hass.config_entries.flow.async_configure(flow["flow_id"], {"name": "Ducks"})
    assert ok["type"] is FlowResultType.CREATE_ENTRY and ok["options"] == {"hens": 0}


async def test_options_change_the_hen_count(hass):
    flow = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    created = await hass.config_entries.flow.async_configure(flow["flow_id"], {"name": "Hens", "hens": 4})
    await hass.async_block_till_done()
    entry = created["result"]

    options = await hass.config_entries.options.async_init(entry.entry_id)
    assert options["type"] is FlowResultType.FORM and options["step_id"] == "init"
    done = await hass.config_entries.options.async_configure(options["flow_id"], {"hens": 9})
    assert done["type"] is FlowResultType.CREATE_ENTRY and entry.options == {"hens": 9}
