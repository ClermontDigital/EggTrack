"""Serve the Egg Track card against the real storage rules and calculations, with made-up data.

No Home Assistant instance is needed, only the package (it's installed by requirements_test.txt).
Used by drive.cjs; also handy for looking at the card by hand:

    python tests/card/server.py        # then open http://127.0.0.1:8799/
"""
import asyncio
import json
import os
import random
import sys
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
from custom_components.egg_track import api  # noqa: E402
from custom_components.egg_track.storage import EggStore, InvalidLog, check_day  # noqa: E402

PORT = int(os.environ.get("PORT", "8799"))
TODAY = date.today()
HENS = 8
ENTRY = SimpleNamespace(entry_id="demo", title="Backyard hens", data={"name": "Backyard hens"}, options={"hens": HENS})


def synthetic() -> dict:
    """150 days from a flock of eight, with a moult a couple of months back and two days nobody logged."""
    rng = random.Random(7)
    days = {}
    for back in range(150, 0, -1):
        rate = 0.72 - (0.38 if 70 <= back <= 95 else 0) + (0.08 if back < 30 else 0)
        if back in (11, 12) or rng.random() < 0.03:
            continue
        days[(TODAY - timedelta(days=back)).isoformat()] = {"eggs": sum(rng.random() < rate for _ in range(HENS))}
    days[(TODAY - timedelta(days=4)).isoformat()]["note"] = "Two from the nest under the lemon tree"
    days[TODAY.isoformat()] = {"eggs": 4}
    return days


class Memory:
    async def async_save(self, data): ...
    async def async_remove(self): ...


def new_store() -> EggStore:
    store = EggStore.__new__(EggStore)      # the real class, without Home Assistant's file store behind it
    store._store, store._lock, store.days = Memory(), asyncio.Lock(), synthetic()
    return store


STATE = {"store": new_store(), "log": [], "fail": 0}


def handle(msg: dict):
    store = STATE["store"]
    kind = msg["type"].split("/")[1]
    day = date.fromisoformat(msg["date"]) if msg.get("date") else TODAY
    if kind not in ("flocks", "overview"):
        STATE["log"].append({k: v for k, v in msg.items() if k != "entry_id"})
    if kind == "flocks":
        return [{"entry_id": ENTRY.entry_id, "name": ENTRY.title, "hens": HENS}]
    if kind == "overview":
        return api.overview(ENTRY, store, TODAY, msg.get("days", 14), day)
    if kind == "days":
        return {d: {"eggs": r.get("eggs"), "note": r.get("note", "")} for d, r in sorted(store.days.items())}
    if STATE["fail"] > 0:
        STATE["fail"] -= 1
        raise InvalidLog("Home Assistant said no")
    check_day(day, TODAY)
    if kind == "add":
        return asyncio.run(store.async_add(day, msg.get("count", 1)))
    if kind == "set_day":
        return asyncio.run(store.async_set(day, msg.get("eggs"), msg.get("note")))
    if kind == "clear_day":
        return asyncio.run(store.async_clear(day))
    raise ValueError(kind)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): ...

    def _send(self, body: bytes, ctype: str = "application/json", code: int = 200) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/card.js":
            self._send((REPO / "custom_components/egg_track/www/egg-track-card.js").read_bytes(), "text/javascript")
        elif path == "/log":
            self._send(json.dumps(STATE["log"]).encode())
        elif path == "/days":
            self._send(json.dumps(STATE["store"].days).encode())
        elif path == "/reset":
            STATE.update(store=new_store(), log=[], fail=0)
            self._send(b"{}")
        elif path == "/fail":
            STATE["fail"] = int(self.path.split("n=")[1]) if "n=" in self.path else 1
            self._send(b"{}")
        else:
            self._send((Path(__file__).parent / "index.html").read_bytes(), "text/html")

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        try:
            self._send(json.dumps(handle(msg)).encode())
        except (InvalidLog, ValueError) as err:
            self._send(json.dumps({"code": "invalid", "message": str(err)}).encode(), code=400)


if __name__ == "__main__":
    print(f"Egg Track card harness on http://127.0.0.1:{PORT}/  (?theme=light, ?view=grid, ?view=compact, ?weeks=8, ?days=30, ?w=300)")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
