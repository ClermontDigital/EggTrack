// Drive the Egg Track card in headless Chrome: check how it behaves, and take the made-up-data README
// screenshots (grid, grid-light, card, card-light). widget.png and widget-popup.png are from a real dashboard.
//
//   pip install -r requirements_test.txt && npm install --no-save puppeteer-core
//   node tests/card/drive.cjs            (starts tests/card/server.py itself)
//
// Environment: CHROME = path to Chrome or Chromium, PYTHON = the Python that has Home Assistant installed,
// PUPPETEER = where to load puppeteer-core from, PORT = the harness port (8799), SHOTS=0 to leave the
// screenshots in images/ alone.
const { spawn } = require("node:child_process");
const path = require("node:path");

const puppeteer = require(process.env.PUPPETEER || "puppeteer-core");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = process.env.PYTHON || "python3";
const PORT = process.env.PORT || "8799";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "..", "..");
const IMAGES = path.join(ROOT, "images");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  — " + detail}`); };

async function main() {
  const server = spawn(PYTHON, [path.join(__dirname, "server.py")], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PORT } });
  let browser;
  try {
    for (let i = 0; ; i++) {
      try { await fetch(`${BASE}/reset`); break; } catch (err) { if (i > 80) throw new Error("the harness server didn't start"); await sleep(250); }
    }
    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
    const p = await browser.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));

    const open = async (qs = "theme=dark", w = 520, h = 900) => {
      await fetch(`${BASE}/reset`);
      await p.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
      await p.goto(`${BASE}/?${qs}`, { waitUntil: "networkidle0" });
      await sleep(300);
    };
    const $ = (sel) => p.evaluateHandle((s) => window.card.shadowRoot.querySelector(s), sel);
    const text = (sel) => p.evaluate((s) => window.card.shadowRoot.querySelector(s)?.textContent.trim().replace(/\s+/g, " ") ?? null, sel);
    const has = (sel) => p.evaluate((s) => !!window.card.shadowRoot.querySelector(s), sel);
    const click = async (sel, wait = 300) => { await (await $(sel)).click(); await sleep(wait); };
    const tapAt = async (sel, times = 1) => {   // the same spot each time, as a finger does
      const b = await (await $(sel)).boundingBox();
      for (let i = 0; i < times; i++) await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    };
    const writes = async () => (await (await fetch(`${BASE}/log`)).json()).filter((m) => m.type !== "egg_track/days");
    const stored = async () => (await fetch(`${BASE}/days`)).json();
    const today = await p.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
    const shot = async (file) => { if (process.env.SHOTS !== "0") await (await p.$("#wrap")).screenshot({ path: path.join(IMAGES, file) }); };

    // ---- what it shows -----------------------------------------------------------------------
    await open();
    check("the flock's name", (await text(".title span")) === "Backyard hens", await text(".title span"));
    check("today's count", (await text(".n")) === "4" && (await text(".unit")) === "eggs today", `${await text(".n")} / ${await text(".unit")}`);
    check("14 bars, today's selected", await p.evaluate(() => { const b = window.card.shadowRoot.querySelectorAll(".bar"); return b.length === 14 && b[13].classList.contains("sel"); }));
    check("lay rate from the hen count", /lay rate from 8 hens/.test(await text(".chips")), await text(".chips"));
    await shot("card.png");

    // ---- logging -----------------------------------------------------------------------------
    await click('[data-act="plus"]'); await click('[data-act="plus"]');
    check("+ twice gives 6", (await text(".n")) === "6", await text(".n"));
    await click('[data-act="minus"]');
    check("− gives 5", (await text(".n")) === "5", await text(".n"));
    let log = await writes();
    check("three adds, all for today", log.length === 3 && log.every((m) => m.type === "egg_track/add" && m.date === today) && log.map((m) => m.count).join() === "1,1,-1", JSON.stringify(log));

    await tapAt('[data-act="plus"]', 5);
    const during = await text(".n"); await sleep(800);
    check("five fast taps land on 10 and stay there", during === "10" && (await text(".n")) === "10", `${during} then ${await text(".n")}`);

    const plus = await (await $('[data-act="plus"]')).boundingBox();
    await p.mouse.move(plus.x + plus.width / 2, plus.y + plus.height / 2); await p.mouse.down();
    await p.evaluate(() => window.notify()); await sleep(250);
    await p.mouse.up(); await sleep(600);
    check("a refresh during a press doesn't swallow the tap", (await text(".n")) === "11", await text(".n"));

    await (await $('[data-act="plus"]')).focus();
    await p.keyboard.press("Enter"); await sleep(350); await p.keyboard.press("Enter"); await sleep(500);
    check("keyboard: Enter twice on + adds two (focus stays put)", (await text(".n")) === "13" && (await p.evaluate(() => window.card.shadowRoot.activeElement?.dataset.act)) === "plus", `${await text(".n")}, focus on ${await p.evaluate(() => window.card.shadowRoot.activeElement?.dataset.act)}`);
    check("the count is announced to screen readers", await has('.count[aria-live="polite"]'));

    // ---- typing an exact count ---------------------------------------------------------------
    await click('[data-act="edit"]');
    check("tapping the number opens a box", await has(".exact"));
    await p.keyboard.type("9"); await p.keyboard.press("Enter"); await sleep(500);
    log = await writes();
    check("typing 9 sets the day to 9", (await text(".n")) === "9" && log.at(-1).type === "egg_track/set_day" && log.at(-1).eggs === 9, `${await text(".n")} ${JSON.stringify(log.at(-1))}`);

    await click('[data-act="edit"]');
    await p.keyboard.type("5000"); await p.keyboard.press("Enter"); await sleep(500);
    check("a refused count shows why and changes nothing", /between 0 and 2000/.test((await text(".err")) || "") && (await text(".n")) === "9", `${await text(".err")} | ${await text(".n")}`);
    await click('[data-act="plus"]');
    check("the message clears on the next action", !(await has(".err")) && (await text(".n")) === "10", `${await text(".err")} | ${await text(".n")}`);

    await click('[data-act="edit"]');
    await p.keyboard.type("1");                                   // on the way to 12 ...
    await p.evaluate(async () => { await fetch("/ws", { method: "POST", body: JSON.stringify({ type: "egg_track/add", entry_id: "demo", count: 1 }) }); window.notify(); });
    await sleep(400);                                             // ... someone else logs an egg
    check("a refresh doesn't close a count that's being typed", await has(".exact"));
    await p.keyboard.type("2"); await p.keyboard.press("Enter"); await sleep(500);
    check("and the finished number is what's saved", (await text(".n")) === "12" && (await stored())[today].eggs === 12, `${await text(".n")} / stored ${(await stored())[today].eggs}`);

    // ---- other days ----------------------------------------------------------------------------
    await click('[data-act="prev"]');
    check("the previous day shows its date and count", /^\w{3} \d+ \w{3}$/.test(await text(".nav .day")) && /eggs? on /.test(await text(".unit")), `${await text(".nav .day")} | ${await text(".unit")}`);
    check("keyboard focus stays on the arrow", (await p.evaluate(() => window.card.shadowRoot.activeElement?.dataset.act)) === "prev");
    await click('[data-act="today"]');
    check("back to today", (await text(".nav .day")) === "Today" && (await p.evaluate(() => window.card.shadowRoot.querySelector('[data-act="next"]').disabled)));

    // ---- a day nobody logged -------------------------------------------------------------------
    const gap = await p.evaluate(() => [...window.card.shadowRoot.querySelectorAll(".bar.unlogged")].at(-1).dataset.date);
    await click(`[data-date="${gap}"]`);
    check("an unlogged day says so", /Not logged yet/.test((await text(".state")) || ""), await text(".state"));
    check("− is switched off at zero", await p.evaluate(() => window.card.shadowRoot.querySelector('[data-act="minus"]').disabled));
    let before = (await writes()).length;
    await click('[data-act="edit"]'); await click(".title");       // open the box, then tap away without typing
    check("opening and leaving the number box logs nothing", (await writes()).length === before && /Not logged yet/.test((await text(".state")) || "") && !(gap in (await stored())), `${(await writes()).length - before} writes | ${await text(".state")}`);

    await (await $(".note")).click(); await p.keyboard.type("Broody hen"); await p.keyboard.press("Tab"); await sleep(500);
    let days = await stored();
    check("a note is saved without logging the day", days[gap]?.note === "Broody hen" && !("eggs" in days[gap]) && /Not logged yet/.test((await text(".state")) || ""), `${JSON.stringify(days[gap])} | ${await text(".state")}`);
    check("the note is still shown", (await p.evaluate(() => window.card.shadowRoot.querySelector(".note").value)) === "Broody hen");
    await click('[data-act="none"]');
    check("'No eggs' logs a zero", (await text(".n")) === "0" && !(await has(".state")) && (await stored())[gap].eggs === 0, `${await text(".n")} | ${JSON.stringify((await stored())[gap])}`);
    await click('[data-act="clear"]');
    check("'Clear this day' forgets the count and the note", /Not logged yet/.test((await text(".state")) || "") && !(gap in (await stored())), JSON.stringify((await stored())[gap]));

    // ---- notes that haven't been "committed" by the browser (a phone doesn't blur on a button tap) ----
    await click('[data-act="today"]');
    await p.evaluate(() => { const n = window.card.shadowRoot.querySelector(".note"); n.focus(); n.value = "Late lay"; n.dispatchEvent(new Event("input", { bubbles: true })); });
    await p.evaluate(() => window.card.shadowRoot.querySelector('[data-act="plus"]').click()); await sleep(600);
    days = await stored();
    check("a typed note is saved when + is tapped straight after", days[today].note === "Late lay" && days[today].eggs === 13, JSON.stringify(days[today]));
    await p.evaluate(() => { const n = window.card.shadowRoot.querySelector(".note"); n.focus(); n.value = "Late lay, two cracked"; n.dispatchEvent(new Event("input", { bubbles: true })); });
    await p.evaluate(() => window.card.shadowRoot.querySelector('[data-act="prev"]').click()); await sleep(600);
    days = await stored();
    const yesterday = await p.evaluate(() => window.card._data.day.date);
    check("a typed note goes to the day it was typed for, not the day moved to", days[today].note === "Late lay, two cracked" && (days[yesterday]?.note || "") !== "Late lay, two cracked" && (await p.evaluate(() => window.card.shadowRoot.querySelector(".note").value)) !== "Late lay, two cracked", `${days[today].note} | ${days[yesterday]?.note}`);
    await p.evaluate(() => { const n = window.card.shadowRoot.querySelector(".note"); n.focus(); n.value = "half-typ"; n.dispatchEvent(new Event("input", { bubbles: true })); window.notify(); });
    await sleep(400);
    check("a refresh keeps a half-typed note and the cursor in it", await p.evaluate(() => { const n = window.card.shadowRoot.querySelector(".note"); return n.value === "half-typ" && window.card.shadowRoot.activeElement === n; }));
    // The day can change under a draft without a tap (midnight): the draft stays with its own day.
    const typedOn = await p.evaluate(() => window.card._data.day.date);
    await p.evaluate((d) => { window.card._selected = d; return window.card._load(); }, today);
    await sleep(300);
    check("a half-typed note isn't shown on a different day", (await p.evaluate(() => window.card.shadowRoot.querySelector(".note").value)) !== "half-typ" && (await p.evaluate(() => window.card._noteDraft?.date)) === typedOn, await p.evaluate(() => window.card.shadowRoot.querySelector(".note").value));
    await p.evaluate(() => window.card._flushNote()); await sleep(300);
    check("and is saved to the day it was typed for", (await stored())[typedOn]?.note === "half-typ", JSON.stringify((await stored())[typedOn]));
    await click('[data-act="today"]');

    // ---- staying in step -----------------------------------------------------------------------
    await p.evaluate(async () => { await fetch("/ws", { method: "POST", body: JSON.stringify({ type: "egg_track/add", entry_id: "demo", count: 1 }) }); window.notify(); });
    await sleep(400);
    check("follows a change made on another device", (await text(".n")) === "14", await text(".n"));

    await p.evaluate(() => { window.offline = true; window.card.hass = window.makeHass(false); });
    await tapAt('[data-act="plus"]', 2); await sleep(600);
    check("offline: taps are taken back and it says why", (await text(".n")) === "14" && /Couldn't reach Home Assistant/.test((await text(".err")) || ""), `${await text(".n")} | ${await text(".err")}`);
    await p.evaluate(async () => { window.offline = false; await fetch("/ws", { method: "POST", body: JSON.stringify({ type: "egg_track/add", entry_id: "demo", count: 2 }) }); window.card.hass = window.makeHass(true); });
    await sleep(500);
    check("back online: catches up without being asked", (await text(".n")) === "16" && !(await has(".err")), `${await text(".n")} | ${await text(".err")}`);
    await p.evaluate(async () => { await fetch("/ws", { method: "POST", body: JSON.stringify({ type: "egg_track/add", entry_id: "demo", count: -1 }) }); document.dispatchEvent(new Event("visibilitychange")); });
    await sleep(500);
    check("coming back to the tab refreshes it", (await text(".n")) === "15", await text(".n"));

    await fetch(`${BASE}/fail?n=1`);
    await click('[data-act="plus"]', 600);
    check("a tap Home Assistant refuses is taken back, with its message", (await text(".n")) === "15" && /Home Assistant said no/.test((await text(".err")) || ""), `${await text(".n")} | ${await text(".err")}`);

    // ---- export --------------------------------------------------------------------------------
    await p.evaluate(() => { window.csv = null; URL.createObjectURL = (blob) => { blob.text().then((t) => { window.csv = t; }); return "blob:test"; }; HTMLAnchorElement.prototype.click = () => {}; });
    await fetch(`${BASE}/ws`, { method: "POST", body: JSON.stringify({ type: "egg_track/set_day", entry_id: "demo", note: '=SUM(A1) "x"' }) });
    await click('[data-act="export"]', 500);
    const csv = (await p.evaluate(() => window.csv)) || "";
    check("the CSV has a header, today's row, and no live formulas", csv.startsWith("date,eggs,note\n") && csv.includes(`${today},15,"'=SUM(A1) ""x"""`), csv.split("\n").at(-2));

    // ---- the grid: an egg for each day ---------------------------------------------------------
    await open("theme=dark&view=grid");
    const tray = await p.evaluate(() => { const r = window.card.shadowRoot; return { cells: r.querySelectorAll(".cell").length, days: r.querySelectorAll("button.cell").length, today: r.querySelector(".cell.now.sel")?.textContent.trim(), chart: !!r.querySelector(".chart"), months: [...r.querySelectorAll(".mon")].map((m) => m.textContent) }; });
    const weekday = (new Date().getDay() + 6) % 7;   // Monday = 0
    check("grid: five weeks, a week to a row, up to today", tray.cells === 35 && tray.days === 28 + weekday + 1 && !tray.chart, JSON.stringify(tray));
    check("grid: today's egg is ringed and carries today's count", tray.today === "4", tray.today);
    check("grid: months are marked", tray.months.length >= 1 && tray.months.every((m) => /^[A-Z][a-z]{2}$/.test(m)), tray.months.join());
    await shot("grid.png");
    const past = await p.evaluate(() => { const c = [...window.card.shadowRoot.querySelectorAll(".cell.egg:not(.now)")].at(-1); return { date: c.dataset.date, eggs: Number(c.textContent) }; });
    await click(`[data-date="${past.date}"]`);
    check("grid: tapping an egg opens that day", (await text(".n")) === String(past.eggs) && /eggs? on /.test(await text(".unit")) && (await has(`[data-date="${past.date}"].sel`)), `${await text(".n")} vs ${past.eggs}`);
    await click('[data-act="plus"]', 60);
    check("grid: + on that day bumps its egg, with a pop", await p.evaluate((d, n) => { const c = window.card.shadowRoot.querySelector(`[data-date="${d}"]`); return c.classList.contains("pop") && c.textContent.trim() === String(n); }, past.date, past.eggs + 1));
    await sleep(500);
    const hollow = await p.evaluate(() => { const c = [...window.card.shadowRoot.querySelectorAll(".cell.gap")].at(-1); return { date: c.dataset.date, text: c.textContent.trim() }; });
    await click(`[data-date="${hollow.date}"]`);
    await click('[data-act="none"]');
    check("grid: an unlogged day is a hollow, a logged zero an empty shell with 0", hollow.text === "" && (await p.evaluate((d) => { const c = window.card.shadowRoot.querySelector(`[data-date="${d}"]`); return c.classList.contains("none") && c.textContent.trim() === "0"; }, hollow.date)));
    await open("theme=light&view=grid"); await shot("grid-light.png");
    await open("theme=dark&view=grid&weeks=8&hide_title=1");
    check("grid: eight weeks, and the title can be hidden", (await p.evaluate(() => window.card.shadowRoot.querySelectorAll(".cell").length)) === 56 && !(await has(".title")) && (await text(".nav .day")) === "Today");
    await open("theme=dark&view=grid&w=260", 320, 900);
    check("grid: nothing overflows a narrow card", await p.evaluate(() => { const c = window.card.shadowRoot.querySelector(".et"); return c.scrollWidth <= c.clientWidth + 1; }));

    // ---- layouts -------------------------------------------------------------------------------
    await open("theme=light"); await shot("card-light.png");
    // ---- compact: a strip, with the grid of days in a popup -------------------------------------
    await open("theme=dark&view=compact&w=440", 520, 760);
    const strip = await p.evaluate(() => { const r = window.card.shadowRoot; return { h: Math.round(r.querySelector("ha-card").getBoundingClientRect().height), avg: r.querySelector(".avg b")?.textContent, label: r.querySelector(".avg span")?.textContent, chart: !!r.querySelector(".chart, .tray") }; });
    check("compact: the count, the 7-day average and no chart", (await text(".n")) === "4" && strip.avg === "6.3" && /7-day average/.test(strip.label) && !strip.chart, JSON.stringify(strip));
    await click('[data-act="calendar"]', 700);
    const pop = await p.evaluate(() => { const d = window.card.shadowRoot.querySelector("dialog.cal"); const g = d?.querySelector("egg-track-card"); return { open: !!d?.open, cells: g?.shadowRoot.querySelectorAll(".cell").length, today: g?.shadowRoot.querySelector(".cell.now")?.textContent.trim(), title: d?.querySelector(".cal-head .title")?.textContent.trim(), nested: !!g?.shadowRoot.querySelector(".title") }; });
    check("compact: the calendar button opens the grid of days in a popup", pop.open && pop.cells === 35 && pop.today === "4" && pop.title === "Backyard hens" && !pop.nested, JSON.stringify(pop));
    check("compact: the popup is solid, whatever the card behind it looks like", await p.evaluate(() => { const c = getComputedStyle(window.card.shadowRoot.querySelector("dialog.cal")).backgroundColor.match(/[\d.]+/g); return c.length === 3 || Number(c[3]) === 1; }));
    await p.evaluate(() => window.card.shadowRoot.querySelector("dialog.cal egg-track-card").shadowRoot.querySelector('[data-act="plus"]').click());
    await sleep(700);
    check("compact: an egg logged in the popup shows on the strip behind it", (await text(".n")) === "5" && (await p.evaluate(() => window.card.shadowRoot.querySelector("dialog.cal egg-track-card").shadowRoot.querySelector(".n").textContent)) === "5", await text(".n"));
    await p.keyboard.press("Escape"); await sleep(500);
    check("compact: Escape closes the popup and puts focus back on its button", !(await has("dialog.cal")) && (await p.evaluate(() => window.card.shadowRoot.activeElement?.dataset.act)) === "calendar", `${await has("dialog.cal")} / ${await p.evaluate(() => window.card.shadowRoot.activeElement?.dataset.act)}`);
    await click('[data-act="calendar"]', 500);
    await p.evaluate(() => window.card.shadowRoot.querySelector("dialog.cal [data-close]").click()); await sleep(400);
    check("compact: the popup's close button closes it", !(await has("dialog.cal")));
    await open("theme=dark&view=compact&w=250", 330, 500);
    check("compact: wraps on a narrow card without overflowing", await p.evaluate(() => { const c = window.card.shadowRoot.querySelector(".et"); return c.scrollWidth <= c.clientWidth + 1; }));
    await open("theme=dark&view=compact&w=380&hide_title=1", 460, 400);
    const bare = await p.evaluate(() => { const r = window.card.shadowRoot; const kids = [...r.querySelector(".strip").children].map((k) => Math.round(k.getBoundingClientRect().top + k.getBoundingClientRect().height / 2)); return { h: Math.round(r.querySelector("ha-card").getBoundingClientRect().height), rows: new Set(kids.map((y) => Math.round(y / 12))).size, title: !!r.querySelector(".title") }; });
    check("compact without its title is one line, under 90 px, on a 380 px card", !bare.title && bare.rows === 1 && bare.h <= 90, JSON.stringify(bare));
    await open("theme=dark&days=30");
    check("a 30-day chart", (await p.evaluate(() => window.card.shadowRoot.querySelectorAll(".bar").length)) === 30);
    await open("theme=dark&w=300", 360, 900);
    check("narrow: totals wrap to two columns and nothing overflows", await p.evaluate(() => { const r = window.card.shadowRoot; const c = r.querySelector(".et"); return getComputedStyle(r.querySelector(".tiles")).gridTemplateColumns.split(" ").length === 2 && c.scrollWidth <= c.clientWidth + 1; }));
    await open("theme=dark&title=" + encodeURIComponent('<img src=x onerror="window.pwned=1">'));
    check("a title with markup is shown as text", !(await p.evaluate(() => window.pwned)) && /<img/.test(await text(".title span")));

    await open();
    await p.evaluate(() => { window.frame = window.card.shadowRoot.querySelector("ha-card"); window.frame.dataset.styled = "yes"; });
    await click('[data-act="plus"]'); await click('[data-act="prev"]');
    check("the card's frame survives redraws (so styling on it doesn't flicker)", await p.evaluate(() => window.card.shadowRoot.querySelector("ha-card") === window.frame && window.frame.dataset.styled === "yes"));
    check("what card-mod adds inside the card is left alone", await has("#from-card-mod"));

    check("no script errors", errors.length === 0, errors.join(" | "));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.length && results.every(Boolean) ? 0 : 1);
}

main().catch((err) => { console.error("driver failed:", err); process.exit(2); });
