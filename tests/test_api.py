"""Setup and the WebSocket API the card uses."""
from datetime import timedelta

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.egg_track.const import DOMAIN
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util


async def setup_flock(hass: HomeAssistant, name: str = "Chickens", hens: int = 8) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, title=name, data={"name": name}, options={"hens": hens})
    entry.add_to_hass(hass)
    assert await async_setup_component(hass, "http", {})
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def ws(client, **msg):
    await client.send_json_auto_id(msg)
    return await client.receive_json()


async def test_flocks_and_empty_overview(hass, hass_ws_client):
    entry = await setup_flock(hass)
    client = await hass_ws_client(hass)
    assert (await ws(client, type=f"{DOMAIN}/flocks"))["result"] == [{"entry_id": entry.entry_id, "name": "Chickens", "hens": 8}]

    today = dt_util.now().date()
    ov = (await ws(client, type=f"{DOMAIN}/overview", entry_id=entry.entry_id))["result"]
    assert ov["flock"] == {"entry_id": entry.entry_id, "name": "Chickens", "hens": 8}
    assert ov["today"] == today.isoformat()
    assert ov["day"] == {"date": today.isoformat(), "eggs": 0, "note": "", "logged": False}
    assert ov["stats"]["all_time"] == 0 and ov["stats"]["daily_average"] is None
    assert len(ov["series"]) == 14 and len(ov["weeks"]) == 12 and len(ov["months"]) == 12


async def test_add_set_and_clear(hass, hass_ws_client, hass_admin_user):
    entry = await setup_flock(hass)
    client = await hass_ws_client(hass)
    today = dt_util.now().date()
    yesterday = (today - timedelta(days=1)).isoformat()

    assert (await ws(client, type=f"{DOMAIN}/add", entry_id=entry.entry_id))["result"]["eggs"] == 1
    assert (await ws(client, type=f"{DOMAIN}/add", entry_id=entry.entry_id, count=3))["result"]["eggs"] == 4
    assert (await ws(client, type=f"{DOMAIN}/add", entry_id=entry.entry_id, count=-10))["result"]["eggs"] == 0   # never below zero

    r = await ws(client, type=f"{DOMAIN}/set_day", entry_id=entry.entry_id, date=yesterday, eggs=6, note="  Two from the new hen ")
    assert r["result"] == {"date": yesterday, "eggs": 6, "note": "Two from the new hen", "logged": True}
    # A note on its own keeps the count; an empty note removes it.
    assert (await ws(client, type=f"{DOMAIN}/set_day", entry_id=entry.entry_id, date=yesterday, note=""))["result"]["note"] == ""
    assert (await ws(client, type=f"{DOMAIN}/set_day", entry_id=entry.entry_id, date=yesterday, note="x"))["result"]["eggs"] == 6

    store = hass.data[DOMAIN][entry.entry_id]["store"]
    assert store.days[yesterday]["updated_by"] == hass_admin_user.id and "updated_at" in store.days[yesterday]

    ov = (await ws(client, type=f"{DOMAIN}/overview", entry_id=entry.entry_id, date=yesterday, days=7))["result"]
    assert ov["day"]["eggs"] == 6 and ov["stats"]["yesterday"] == 6 and ov["stats"]["all_time"] == 6
    assert ov["stats"]["logged_today"] is True and len(ov["series"]) == 7

    days = (await ws(client, type=f"{DOMAIN}/days", entry_id=entry.entry_id))["result"]
    assert days == {yesterday: {"eggs": 6, "note": "x"}, today.isoformat(): {"eggs": 0, "note": ""}}
    only = (await ws(client, type=f"{DOMAIN}/days", entry_id=entry.entry_id, start=today.isoformat()))["result"]
    assert list(only) == [today.isoformat()]

    cleared = (await ws(client, type=f"{DOMAIN}/clear_day", entry_id=entry.entry_id, date=yesterday))["result"]
    assert cleared == {"date": yesterday, "eggs": 0, "note": "", "logged": False}
    assert yesterday not in store.days


async def test_bad_input_is_refused(hass, hass_ws_client):
    entry = await setup_flock(hass)
    client = await hass_ws_client(hass)
    future = (dt_util.now().date() + timedelta(days=3)).isoformat()

    r = await ws(client, type=f"{DOMAIN}/add", entry_id=entry.entry_id, date=future)
    assert not r["success"] and r["error"]["code"] == "invalid"
    r = await ws(client, type=f"{DOMAIN}/set_day", entry_id=entry.entry_id, date=future, eggs=2)
    assert not r["success"] and r["error"]["code"] == "invalid"
    assert not (await ws(client, type=f"{DOMAIN}/set_day", entry_id=entry.entry_id, eggs=-1))["success"]
    assert not (await ws(client, type=f"{DOMAIN}/set_day", entry_id=entry.entry_id, date="13/10/2026", eggs=1))["success"]
    r = await ws(client, type=f"{DOMAIN}/set_day", entry_id=entry.entry_id, note="n" * 201)
    assert not r["success"] and r["error"]["code"] == "invalid"
    r = await ws(client, type=f"{DOMAIN}/overview", entry_id="nope")
    assert not r["success"] and r["error"]["code"] == "not_found"
    assert hass.data[DOMAIN][entry.entry_id]["store"].days == {}


async def test_subscribers_hear_about_changes(hass, hass_ws_client):
    entry = await setup_flock(hass)
    watcher = await hass_ws_client(hass)
    await watcher.send_json_auto_id({"type": f"{DOMAIN}/subscribe", "entry_id": entry.entry_id})
    sub = await watcher.receive_json()
    assert sub["success"]

    logger = await hass_ws_client(hass)
    assert (await ws(logger, type=f"{DOMAIN}/add", entry_id=entry.entry_id))["success"]
    event = await watcher.receive_json()
    assert event["type"] == "event" and event["id"] == sub["id"] and event["event"] == {"changed": True}


async def test_two_flocks_keep_separate_logs_and_removal_deletes_the_log(hass, hass_ws_client, hass_storage):
    hens = await setup_flock(hass, "Hens", 6)
    ducks = await setup_flock(hass, "Ducks", 0)
    client = await hass_ws_client(hass)
    await ws(client, type=f"{DOMAIN}/add", entry_id=hens.entry_id, count=5)
    await ws(client, type=f"{DOMAIN}/add", entry_id=ducks.entry_id, count=2)
    assert (await ws(client, type=f"{DOMAIN}/overview", entry_id=hens.entry_id))["result"]["stats"]["today"] == 5
    ov = (await ws(client, type=f"{DOMAIN}/overview", entry_id=ducks.entry_id))["result"]
    assert ov["stats"]["today"] == 2 and ov["stats"]["lay_rate"] is None

    await hass.async_block_till_done()
    assert await hass.config_entries.async_remove(ducks.entry_id)
    await hass.async_block_till_done()
    assert f"{DOMAIN}.{ducks.entry_id}" not in hass_storage
    assert [f["name"] for f in (await ws(client, type=f"{DOMAIN}/flocks"))["result"]] == ["Hens"]


async def test_notes_and_take_aways_do_not_turn_an_unlogged_day_into_zero(hass, hass_ws_client):
    entry = await setup_flock(hass)
    client = await hass_ws_client(hass)
    store = hass.data[DOMAIN][entry.entry_id]["store"]
    today = dt_util.now().date().isoformat()

    # Taking an egg away from a day with no count, or adding none, changes nothing.
    assert (await ws(client, type=f"{DOMAIN}/add", entry_id=entry.entry_id, count=-1))["result"]["logged"] is False
    assert (await ws(client, type=f"{DOMAIN}/add", entry_id=entry.entry_id, count=0))["result"]["logged"] is False
    assert store.days == {}

    # A note is kept, but the day still isn't logged.
    r = await ws(client, type=f"{DOMAIN}/set_day", entry_id=entry.entry_id, note="Broody hen")
    assert r["result"] == {"date": today, "eggs": 0, "note": "Broody hen", "logged": False}
    ov = (await ws(client, type=f"{DOMAIN}/overview", entry_id=entry.entry_id))["result"]
    assert ov["stats"]["logged_today"] is False and ov["stats"]["last_logged"] is None and ov["series"][-1]["logged"] is False
    assert (await ws(client, type=f"{DOMAIN}/days", entry_id=entry.entry_id))["result"] == {today: {"eggs": None, "note": "Broody hen"}}

    # Removing the note removes the record; a count of zero is a real entry.
    assert (await ws(client, type=f"{DOMAIN}/set_day", entry_id=entry.entry_id, note=""))["result"]["logged"] is False
    assert store.days == {}
    assert (await ws(client, type=f"{DOMAIN}/set_day", entry_id=entry.entry_id, eggs=0))["result"]["logged"] is True
    assert (await ws(client, type=f"{DOMAIN}/add", entry_id=entry.entry_id, count=-1))["result"] == {"date": today, "eggs": 0, "note": "", "logged": True}

    # Nothing to change is an error, not a silent zero.
    r = await ws(client, type=f"{DOMAIN}/set_day", entry_id=entry.entry_id)
    assert not r["success"] and r["error"]["code"] == "invalid"


async def test_fifty_adds_at_once_all_count(hass, hass_ws_client):
    import asyncio

    entry = await setup_flock(hass)
    store = hass.data[DOMAIN][entry.entry_id]["store"]
    today = dt_util.now().date()
    await asyncio.gather(*(store.async_add(today, 1) for _ in range(50)))
    assert store.record(today)["eggs"] == 50


async def test_the_card_resource_is_registered_once_and_removed_with_the_last_flock(hass):
    from homeassistant.components.lovelace import LOVELACE_DATA

    assert await async_setup_component(hass, "lovelace", {})
    first = await setup_flock(hass, "Hens")
    second = await setup_flock(hass, "Ducks")
    resources = hass.data[LOVELACE_DATA].resources

    def ours():
        return [i["url"] for i in resources.async_items() if i["url"].startswith("/egg_track/")]

    assert len(ours()) == 1 and ours()[0].startswith("/egg_track/egg-track-card.js?v=")
    assert await hass.config_entries.async_reload(first.entry_id)
    await hass.async_block_till_done()
    assert len(ours()) == 1

    assert await hass.config_entries.async_remove(first.entry_id)
    await hass.async_block_till_done()
    assert len(ours()) == 1                      # still one flock using it
    assert await hass.config_entries.async_remove(second.entry_id)
    await hass.async_block_till_done()
    assert ours() == []

    await setup_flock(hass, "Geese")             # and it comes back with the next flock
    assert len(ours()) == 1
