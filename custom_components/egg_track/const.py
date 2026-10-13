"""Constants for Egg Track."""
from __future__ import annotations

DOMAIN = "egg_track"

CONF_NAME = "name"
CONF_HENS = "hens"              # laying hens in the flock; 0 = not set, so no lay rate

DEFAULT_NAME = "Chickens"
MAX_HENS = 1000
MAX_EGGS = 2000                 # per day
MAX_NOTE = 200

CARD_FILENAME = "egg-track-card.js"
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"

SIGNAL_UPDATED = f"{DOMAIN}_updated_{{}}"  # format with entry_id

SERVICE_ADD_EGGS = "add_eggs"
SERVICE_SET_EGGS = "set_eggs"
ATTR_ENTRY_ID = "entry_id"
ATTR_COUNT = "count"
ATTR_EGGS = "eggs"
ATTR_DATE = "date"
ATTR_NOTE = "note"
