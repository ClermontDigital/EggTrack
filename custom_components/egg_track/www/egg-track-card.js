/* Egg Track card - log the eggs your chickens lay each day.
 * Buildless: plain JS custom element, served by the egg_track integration.
 * Colours come from the Home Assistant theme; set --egg-track-accent to change the yolk colour.
 */
const ET_VERSION = "0.1.2";

const ET_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ET_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ET_OFFLINE = "Couldn't reach Home Assistant. Check the connection and try again.";
const etEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const etParse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const etIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const etShift = (s, n) => { const d = etParse(s); d.setDate(d.getDate() + n); return etIso(d); };
const etShort = (s) => { const d = etParse(s); return `${d.getDate()} ${ET_MONTHS[d.getMonth()]}`; };
const etLong = (s) => { const d = etParse(s); return `${ET_WEEKDAYS[d.getDay()]} ${d.getDate()} ${ET_MONTHS[d.getMonth()]}`; };
const etNum = (n) => Number(n).toLocaleString();
const etDec = (n) => (Number.isInteger(+n) ? String(+n) : (+n).toFixed(1));
const etEggs = (n) => (n === 1 ? "egg" : "eggs");
// Home Assistant's connection rejects with a bare number when the socket is down.
const etMessage = (err) => (err && typeof err === "object" && err.message ? String(err.message) : ET_OFFLINE);
// A spreadsheet treats a cell starting with one of these as a formula.
const etCsvText = (s) => `"${(/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;

class EggTrackCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { view: "full", days: 14, weeks: 5 };
    this._selected = null;    // the day being looked at; null = today
    this._editing = false;    // typing an exact count
    this._exactDirty = false; // ... and something has actually been typed
    this._noteDraft = null;   // { date, value }: a note being typed, until it's saved
    this._pending = 0;        // taps on their way to Home Assistant
    this._seq = 0;
    const root = this.shadowRoot;
    // The frame is built once, here, and only its inside is ever redrawn. card-mod and themes put their
    // styling next to it or on it, so nothing else in the shadow root is touched after this.
    root.innerHTML = `<style>${EggTrackCard.styles}</style><ha-card></ha-card>`;
    this._frame = root.querySelector("ha-card");
    root.addEventListener("click", (ev) => this._onClick(ev));
    root.addEventListener("input", (ev) => this._onInput(ev));
    root.addEventListener("change", (ev) => { if (ev.target.classList?.contains("note")) this._saveNote(); });
    root.addEventListener("keydown", (ev) => this._onKey(ev));
    root.addEventListener("focusout", (ev) => { if (ev.target.classList?.contains("exact")) this._commitExact(ev.target); });
    // Redrawing while a finger is down on a button would swallow the tap, so a redraw waits for the release.
    root.addEventListener("pointerdown", () => { this._pressing = true; });
    this._release = () => {
      this._pressing = false;
      if (this._renderQueued) setTimeout(() => this._render(), 0);
    };
    this._visibility = () => {
      if (document.visibilityState === "visible") this._load();   // the app was in the background: catch up
      else this._flushNote();
    };
  }

  setConfig(config) {
    const days = Number(config?.days ?? 14);
    const weeks = Number(config?.weeks ?? 5);
    if (config?.view && !["full", "grid", "compact"].includes(config.view)) throw new Error("Egg Track: view must be full, grid or compact");
    if (!Number.isInteger(days) || days < 7 || days > 60) throw new Error("Egg Track: days must be a whole number from 7 to 60");
    if (!Number.isInteger(weeks) || weeks < 2 || weeks > 12) throw new Error("Egg Track: weeks must be a whole number from 2 to 12");
    const flockChanged = (config?.entry_id || null) !== (this._config.entry_id || null);
    this._config = { view: "full", ...config, days, weeks };
    if (flockChanged) { this._unsubscribe(); this._entryId = null; this._data = null; this._noteDraft = null; }
    if (this._hass) this._load();
  }

  static getStubConfig() { return {}; }

  static getConfigForm() {
    const labels = { entry_id: "Flock", view: "Layout", days: "Days in the chart", weeks: "Weeks in the grid", title: "Title", hide_title: "Hide the title" };
    const helpers = { entry_id: "Leave empty to use your first flock.", title: "Leave empty to use the flock's name.",
      days: "For the full layout.", weeks: "For the grid layout.", hide_title: "For when the card sits under a heading of its own." };
    return {
      schema: [
        { name: "entry_id", selector: { config_entry: { integration: "egg_track" } } },
        { name: "view", selector: { select: { mode: "dropdown", options: [{ value: "full", label: "Full: chart and totals" }, { value: "grid", label: "Grid: an egg for each day" }, { value: "compact", label: "Compact: just today" }] } } },
        { name: "weeks", selector: { number: { min: 2, max: 12, step: 1, mode: "box" } } },
        { name: "days", selector: { number: { min: 7, max: 60, step: 1, mode: "box" } } },
        { name: "title", selector: { text: {} } },
        { name: "hide_title", selector: { boolean: {} } },
      ],
      computeLabel: (schema) => labels[schema.name],
      computeHelper: (schema) => helpers[schema.name],
    };
  }

  getCardSize() { return { compact: 2, grid: 6 }[this._config.view] || 7; }
  getGridOptions() {
    return this._config.view === "compact" ? { columns: 6, rows: 2, min_columns: 4, min_rows: 2 } : { columns: 12, rows: "auto", min_columns: 6 };
  }

  set hass(hass) {
    const first = !this._hass;
    const wasDown = this._connected === false;
    this._hass = hass;
    this._connected = hass.connected !== false;
    if (first) { this._load(); return; }
    if (wasDown && this._connected) {   // back online: catch up on whatever happened meanwhile
      if (this._error === ET_OFFLINE) this._error = null;
      this._load();
      return;
    }
    const now = etIso(new Date());
    if (this._clockDay && now !== this._clockDay) {   // midnight: start a new day
      this._clockDay = now;
      this._selected = null;
      this._load();
    }
  }

  connectedCallback() {
    window.addEventListener("pointerup", this._release, true);
    window.addEventListener("pointercancel", this._release, true);
    document.addEventListener("visibilitychange", this._visibility);
    if (this._hass && this._entryId) { this._subscribe(); this._load(); }
  }

  disconnectedCallback() {
    window.removeEventListener("pointerup", this._release, true);
    window.removeEventListener("pointercancel", this._release, true);
    document.removeEventListener("visibilitychange", this._visibility);
    this._pressing = false;
    this._flushNote();
    this._unsubscribe();
  }

  _ws(msg) { return this._hass.callWS(msg); }

  async _load() {
    if (this._pending) return;   // taps still on their way: the last one reloads
    const seq = (this._seq += 1);
    try {
      if (!this._entryId) {
        if (this._config.entry_id) this._entryId = this._config.entry_id;
        else {
          const flocks = await this._ws({ type: "egg_track/flocks" });
          if (seq !== this._seq) return;
          if (!flocks.length) { this._data = null; this._empty = true; this._loadError = null; this._render(); return; }
          this._entryId = flocks[0].entry_id;
        }
      }
      const grid = this._config.view === "grid";
      const msg = { type: "egg_track/overview", entry_id: this._entryId, days: grid ? this._config.weeks * 7 : this._config.days };
      if (this._selected) msg.date = this._selected;
      const data = await this._ws(msg);
      if (seq !== this._seq) return;   // a newer request, or a tap, has overtaken this one
      this._data = data;
      this._empty = false;
      this._loadError = null;
      this._clockDay = etIso(new Date());
      if (!this._unsub && this.isConnected) this._subscribe();
    } catch (err) {
      if (seq !== this._seq) return;
      this._loadError = etMessage(err);
    }
    this._render();
  }

  _subscribe() {
    if (this._subscribing || this._unsub || !this._entryId) return;
    this._subscribing = true;
    this._hass.connection.subscribeMessage(() => this._load(), { type: "egg_track/subscribe", entry_id: this._entryId })
      .then((unsub) => { this._unsub = unsub; if (!this.isConnected) this._unsubscribe(); })
      .catch(() => {})
      .finally(() => { this._subscribing = false; });
  }

  _unsubscribe() {
    if (this._unsub) { try { this._unsub(); } catch (_) { /* connection already gone */ } this._unsub = null; }
  }

  // Writes ---------------------------------------------------------------------------------------

  async _send(msg) {
    // The day on screen, not one that's still loading after a tap on a bar or an arrow.
    try {
      await this._ws({ entry_id: this._entryId, date: this._data.day.date, ...msg });
    } catch (err) {
      this._error = etMessage(err);
    }
    await this._load();
  }

  async _add(count) {
    const day = this._data.day;
    if (count < 0 && day.eggs === 0) return;   // nothing to take away
    const before = day.eggs;
    const wasLogged = day.logged;
    day.eggs = Math.max(0, before + count);   // show the change straight away; the reload after the last tap confirms it
    day.logged = true;
    const applied = day.eggs - before;
    if (count > 0) this._pop = { date: day.date, at: performance.now() };   // the day's egg in the tray gives a little bounce
    this._seq += 1;   // an overview already on its way would undo this on screen
    this._render();
    this._pending += 1;
    try {
      await this._ws({ type: "egg_track/add", entry_id: this._entryId, date: day.date, count });
    } catch (err) {
      this._error = etMessage(err);
      if (this._data.day === day) {   // it didn't happen: take it back
        day.eggs = Math.max(0, day.eggs - applied);
        if (!wasLogged && day.eggs === 0) day.logged = false;
      }
    }
    this._pending -= 1;
    if (!this._pending) await this._load();
  }

  _saveNote() { return this._flushNote().then(() => this._load()); }

  async _flushNote() {
    const draft = this._noteDraft;
    if (!draft || !this._entryId) return;
    this._noteDraft = null;
    const day = this._data?.day;
    if (day && day.date === draft.date && draft.value.trim() === (day.note || "")) return;   // nothing changed
    try {
      await this._ws({ type: "egg_track/set_day", entry_id: this._entryId, date: draft.date, note: draft.value });
    } catch (err) {
      this._error = etMessage(err);
      if (!this._noteDraft) this._noteDraft = draft;   // keep what was typed
    }
  }

  _commitExact(input) {
    if (!this._editing) return;
    this._editing = false;
    const typed = this._exactDirty;
    this._exactDirty = false;
    const text = input.value.trim();
    const value = Number(text);
    // Opened and closed without typing, or emptied: leave the day exactly as it was.
    if (!typed || text === "" || (value === this._data.day.eggs && this._data.day.logged)) { this._render(); return; }
    if (!Number.isInteger(value) || value < 0) { this._error = "Type a whole number of eggs."; this._render(); return; }
    this._error = null;
    this._send({ type: "egg_track/set_day", eggs: value });
  }

  // Events ---------------------------------------------------------------------------------------

  _onInput(ev) {
    const el = ev.target;
    if (el.classList?.contains("exact")) this._exactDirty = true;
    else if (el.classList?.contains("note") && this._data) this._noteDraft = { date: this._data.day.date, value: el.value };
  }

  _onKey(ev) {
    if (!ev.target.classList?.contains("exact")) return;
    if (ev.key === "Enter") { ev.preventDefault(); this._commitExact(ev.target); }
    if (ev.key === "Escape") { this._editing = false; this._exactDirty = false; this._render(); }
  }

  async _onClick(ev) {
    const bar = ev.target.closest("[data-date]");
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (!bar && !act) return;
    if (act === "retry") { this._load(); return; }
    if (!this._data) return;
    this._error = null;
    // On a phone a tap doesn't always take focus off the note first, so save it before anything else.
    if (this._noteDraft) await this._flushNote();
    if (bar) { this._select(bar.dataset.date); return; }
    if (act === "plus") this._add(1);
    else if (act === "minus") this._add(-1);
    else if (act === "none") this._send({ type: "egg_track/set_day", eggs: 0 });
    else if (act === "clear") this._send({ type: "egg_track/clear_day" });
    else if (act === "prev") this._select(etShift(this._data.day.date, -1));
    else if (act === "next") this._select(etShift(this._data.day.date, 1));
    else if (act === "today") this._select(this._data.today);
    else if (act === "export") this._export();
    else if (act === "edit") {
      this._editing = true;
      this._exactDirty = false;
      this._render();
      const input = this.shadowRoot.querySelector(".exact");
      if (input) { input.focus(); input.select(); }
    }
  }

  _select(day) {
    if (day > this._data.today) return;
    this._selected = day === this._data.today ? null : day;
    this._editing = false;
    this._load();
  }

  async _export() {
    try {
      const days = await this._ws({ type: "egg_track/days", entry_id: this._entryId });
      const rows = ["date,eggs,note", ...Object.entries(days).map(([d, r]) => `${d},${r.eggs ?? ""},${etCsvText(r.note || "")}`)];
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([rows.join("\n") + "\n"], { type: "text/csv" }));
      link.download = `egg-track-${(this._data.flock.name || "flock").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);   // the Android app needs a while to pick it up
    } catch (err) {
      this._error = etMessage(err);
      this._render();
    }
  }

  // Drawing --------------------------------------------------------------------------------------

  _render() {
    const root = this.shadowRoot;
    // Not while a finger is down on a button, and not under a count that's being typed.
    if (this._pressing || (this._editing && root.querySelector(".exact"))) { this._renderQueued = true; return; }
    this._renderQueued = false;
    // Put keyboard focus (and a half-typed note's cursor) back where it was.
    const active = root.activeElement;
    let focus = null;
    let caret = null;
    if (active?.dataset?.act) focus = `[data-act="${active.dataset.act}"]`;
    else if (active?.dataset?.date) focus = `[data-date="${active.dataset.date}"]`;
    else if (active?.classList?.contains("note")) { focus = ".note"; caret = active.selectionStart; }
    this._frame.innerHTML = this._body();
    const el = focus && root.querySelector(focus);
    if (el && !el.disabled) {
      el.focus({ preventScroll: true });
      if (caret != null) { try { el.setSelectionRange(caret, caret); } catch (_) { /* not a text field */ } }
    }
  }

  _body() {
    if (this._empty) {
      return `<div class="et msg"><ha-icon icon="mdi:egg-outline"></ha-icon><p>No flock yet. Add one in Settings, Devices &amp; services, Add integration, <b>Egg Track</b>.</p><button class="link" data-act="retry">Check again</button></div>`;
    }
    if (!this._data) {
      return this._loadError
        ? `<div class="et msg"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><p>${etEsc(this._loadError)}</p><button class="link" data-act="retry">Try again</button></div>`
        : `<div class="et msg"><p>Loading…</p></div>`;
    }
    const { flock, today, day, stats } = this._data;
    const isToday = day.date === today;
    const title = etEsc(this._config.title || flock.name);
    const when = isToday ? "today" : `on ${etLong(day.date)}`;
    const count = this._editing
      ? `<input class="exact" type="number" inputmode="numeric" min="0" step="1" value="${day.eggs}" aria-label="Eggs ${when}">`
      : `<button class="n" data-act="edit" title="Tap to type a number" aria-label="${day.eggs} ${etEggs(day.eggs)} ${when}. Tap to type a number.">${etNum(day.eggs)}</button>`;
    const counter = `
      <div class="counter">
        <button class="round" data-act="minus" aria-label="Remove an egg" ${day.eggs === 0 ? "disabled" : ""}><span>−</span></button>
        <div class="count" aria-live="polite" aria-atomic="true">${count}<span class="unit">${etEggs(day.eggs)} ${when}</span></div>
        <button class="round plus" data-act="plus" aria-label="Add an egg"><span>+</span></button>
      </div>`;
    const name = this._config.hide_title ? "" : `<div class="title"><ha-icon icon="mdi:egg"></ha-icon><span>${title}</span></div>`;
    const head = `
        <div class="head${name ? "" : " bare"}">
          ${name}
          <div class="nav">
            <button class="icon" data-act="prev" aria-label="Previous day">‹</button>
            <button class="day" data-act="today" ${isToday ? "disabled" : ""} title="${isToday ? "" : "Back to today"}">${isToday ? "Today" : etLong(day.date)}</button>
            <button class="icon" data-act="next" aria-label="Next day" ${isToday ? "disabled" : ""}>›</button>
          </div>
        </div>`;
    const problem = this._error || this._loadError;
    const error = problem ? `<div class="err" role="alert">${etEsc(problem)}</div>` : "";

    if (this._config.view === "compact") {
      const bits = [];
      if (stats.daily_average != null) bits.push(`${etDec(stats.daily_average)} a day`);
      bits.push(`${etNum(stats.last_7_days)} in 7 days`);
      return `<div class="et compact">${name ? `<div class="head">${name}</div>` : ""}${counter}${error || `<div class="sub">${bits.join(", ")}</div>`}</div>`;
    }

    const state = day.logged ? "" : `<div class="state"><span>Not logged yet.</span> <button class="link" data-act="none">No eggs ${isToday ? "today" : "this day"}</button></div>`;
    const clear = day.logged || day.note ? `<button class="link quiet" data-act="clear" title="Forget this day's count and note">Clear this day</button>` : "";

    if (this._config.view === "grid") {
      let line = `${etNum(stats.last_7_days)} ${etEggs(stats.last_7_days)} in the last 7 days`;
      if (stats.daily_average != null) line += `, ${etDec(stats.daily_average)} a day`;
      if (stats.lay_rate != null) line += `, ${Math.round(stats.lay_rate)}% lay rate`;
      return `
      <div class="et grid">
        ${head}
        ${counter}
        ${state}
        ${error}
        ${this._tray()}
        <div class="foot"><span>${line}</span><span class="actions">${clear}</span></div>
      </div>`;
    }

    const chips = [];
    if (stats.daily_average != null) chips.push(`<span><b>${etDec(stats.daily_average)}</b> a day, 7-day average</span>`);
    if (stats.lay_rate != null) chips.push(`<span><b>${Math.round(stats.lay_rate)}%</b> lay rate from ${flock.hens} ${flock.hens === 1 ? "hen" : "hens"}</span>`);
    if (stats.streak > 1) chips.push(`<span><b>${stats.streak}</b> days in a row</span>`);

    const dozens = stats.all_time >= 12 ? `<small>${etDec(Math.round(stats.all_time / 1.2) / 10)} dozen</small>` : "";
    const best = stats.best_day ? `Best day: ${stats.best_eggs} on ${etShort(stats.best_day)}` : "";
    const note = this._noteDraft && this._noteDraft.date === day.date ? this._noteDraft.value : day.note;

    return `
      <div class="et">
        ${head}
        ${counter}
        ${state}
        ${error}
        ${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}
        ${this._chart()}
        <div class="tiles">
          <div><span>Last 7 days</span><b>${etNum(stats.last_7_days)}</b></div>
          <div><span>This month</span><b>${etNum(stats.this_month)}</b></div>
          <div><span>This year</span><b>${etNum(stats.this_year)}</b></div>
          <div><span>All time</span><b>${etNum(stats.all_time)}</b>${dozens}</div>
        </div>
        <input class="note" type="text" maxlength="200" enterkeyhint="done" placeholder="Note for ${isToday ? "today" : etShort(day.date)} (optional)" aria-label="Note for ${isToday ? "today" : etLong(day.date)}" value="${etEsc(note)}">
        <div class="foot"><span>${best}</span><span class="actions">${clear}<button class="link" data-act="export">Export CSV</button></span></div>
      </div>`;
  }

  _tray() {
    // An egg for each day, a week to a row (Monday first), this week at the bottom.
    const { series, day, today } = this._data;
    const byDate = new Map(series.map((r) => [r.date, r]));
    // Shade from the lightest to the best day on show, so a flock's own good and poor days stand apart.
    const laid = series.filter((r) => r.eggs > 0).map((r) => r.eggs);
    const top = Math.max(1, ...laid);
    const low = Math.min(top, ...laid);
    const now = etParse(today);
    const monday = etShift(today, -((now.getDay() + 6) % 7));
    const first = etShift(monday, -7 * (this._config.weeks - 1));
    // The bounce outlives the redraw that follows Home Assistant's answer: pick it up where it had got to.
    const popped = this._pop ? performance.now() - this._pop.at : Infinity;
    const pop = popped < 320 ? this._pop.date : null;
    let cells = "";
    for (let i = 0; i < this._config.weeks * 7; i++) {
      const date = etShift(first, i);
      const d = etParse(date);
      const r = byDate.get(date);
      const month = d.getDate() === 1 || i === 0 ? `<span class="mon">${ET_MONTHS[d.getMonth()]}</span>` : "";
      if (date > today || !r) { cells += `<span class="cell">${month}</span>`; continue; }
      const what = r.logged ? `${r.eggs} ${etEggs(r.eggs)}` : "not logged";
      const kind = !r.logged ? "gap" : r.eggs ? "egg" : "none";
      const cls = ["cell", kind, date === day.date ? "sel" : "", date === today ? "now" : "", date === pop ? "pop" : ""].filter(Boolean).join(" ");
      const styles = r.eggs ? [`--t:${(top > low ? (r.eggs - low) / (top - low) : 0.6).toFixed(2)}`] : [];
      if (date === pop) styles.push(`animation-delay:-${Math.round(popped)}ms`);
      const shade = styles.length ? `style="${styles.join(";")}"` : "";
      cells += `<button class="${cls}" data-date="${date}" title="${etLong(date)}: ${what}" aria-label="${etLong(date)}: ${what}">${month}<span class="shell" ${shade}>${r.logged ? r.eggs : ""}</span></button>`;
    }
    const names = ["M", "T", "W", "T", "F", "S", "S"].map((n) => `<span>${n}</span>`).join("");
    return `<div class="tray" role="group" aria-label="Eggs each day, last ${this._config.weeks} weeks"><div class="names" aria-hidden="true">${names}</div><div class="cells">${cells}</div></div>`;
  }

  _chart() {
    const { series, day } = this._data;
    const top = Math.max(1, ...series.map((r) => r.eggs));
    const every = series.length > 31 ? 7 : series.length > 16 ? 2 : 1;   // thin the labels on a long chart
    const bars = series.map((r, i) => {
      const d = etParse(r.date);
      const label = (series.length - 1 - i) % every === 0 ? d.getDate() : "";
      const height = r.eggs ? Math.max(6, Math.round((r.eggs / top) * 100)) : 0;
      const what = r.logged ? `${r.eggs} ${etEggs(r.eggs)}` : "not logged";
      const cls = ["bar", r.date === day.date ? "sel" : "", r.logged ? "" : "unlogged", series.length > 21 ? "dense" : ""].join(" ");
      return `<button class="${cls}" data-date="${r.date}" title="${etLong(r.date)}: ${what}" aria-label="${etLong(r.date)}: ${what}">
        <span class="v">${r.logged && series.length <= 21 ? r.eggs : ""}</span><span class="col"><i style="height:${height}%"></i></span><span class="d">${label}</span></button>`;
    }).join("");
    return `<div class="chart" role="group" aria-label="Eggs per day, last ${series.length} days">${bars}</div>`;
  }

  static get styles() {
    return `
    :host { display: block; --et-accent: var(--egg-track-accent, #F2B544); --et-on-accent: #3A2A00;
      --et-shell-pale: var(--egg-track-shell-pale, #F6ECD6); --et-shell-rich: var(--egg-track-shell-rich, #E39A2B); --et-ink: #4A2C0A;
      --et-round: ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", inherit;
      --et-egg: 50% 50% 50% 50% / 60% 60% 40% 40%; }
    ha-card { overflow: hidden; container-type: inline-size; height: 100%; box-sizing: border-box; }
    .et { padding: 16px; color: var(--primary-text-color); display: grid; gap: 14px; font-family: var(--paper-font-body1_-_font-family, inherit); }
    .et.compact { gap: 2px; padding: 8px 14px; height: 100%; box-sizing: border-box; align-content: center; }
    .msg { justify-items: center; text-align: center; color: var(--secondary-text-color); padding: 28px 16px; }
    .msg ha-icon { --mdc-icon-size: 36px; color: var(--et-accent); }
    .msg p { margin: 0; max-width: 34ch; line-height: 1.45; }
    button { font: inherit; color: inherit; cursor: pointer; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
    .title { display: flex; align-items: center; gap: 8px; font-size: 1.1rem; font-weight: 600; min-width: 0; }
    .title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title ha-icon { color: var(--et-accent); flex: none; }
    .compact .title { font-size: 1rem; }
    .compact .title ha-icon { --mdc-icon-size: 20px; }
    .nav { display: flex; align-items: center; gap: 2px; flex: none; }
    .nav button { background: none; border: 0; border-radius: 8px; padding: 6px 8px; color: var(--secondary-text-color); }
    .nav .icon { font-size: 1.3rem; line-height: 1; min-width: 34px; min-height: 34px; }
    .nav .day { font-size: 0.9rem; font-weight: 500; color: var(--primary-text-color); }
    .nav button:disabled { cursor: default; opacity: 0.45; }
    .nav .day:disabled { opacity: 1; }
    .nav button:not(:disabled):hover { background: var(--secondary-background-color); }
    .counter { display: flex; align-items: center; justify-content: center; gap: 18px; }
    .round { width: 60px; height: 60px; flex: none; border-radius: 50%; border: 2px solid var(--et-accent); background: transparent; color: var(--primary-text-color);
      font-size: 2rem; line-height: 1; display: grid; place-items: center; transition: transform 0.08s ease, background 0.15s ease; }
    .round span { margin-top: -3px; }
    .round.plus { width: 54px; height: 66px; border: 0; border-radius: var(--et-egg); color: var(--et-on-accent);
      background: radial-gradient(circle at 34% 26%, rgba(255,255,255,0.55), transparent 44%), var(--et-accent);
      box-shadow: inset -4px -6px 0 rgba(0,0,0,0.10); }
    .round:not(:disabled):hover { background: color-mix(in srgb, var(--et-accent) 18%, transparent); }
    .round.plus:hover { background: radial-gradient(circle at 34% 26%, rgba(255,255,255,0.7), transparent 46%), color-mix(in srgb, var(--et-accent) 90%, #fff); }
    .round:not(:disabled):active { transform: scale(0.94); }
    .round:disabled { opacity: 0.35; cursor: default; }
    .count { display: grid; justify-items: center; min-width: 112px; }
    .n { background: none; border: 0; padding: 0 8px; font-family: var(--et-round); font-size: 3.4rem; font-weight: 700; line-height: 1.05; font-variant-numeric: tabular-nums; border-radius: 10px; }
    .n:hover { background: var(--secondary-background-color); }
    .exact { width: 5.2ch; font: inherit; font-size: 2.6rem; font-weight: 700; text-align: center; color: var(--primary-text-color);
      background: var(--secondary-background-color); border: 2px solid var(--et-accent); border-radius: 10px; padding: 2px 4px; }
    .unit { font-size: 0.85rem; color: var(--secondary-text-color); }
    .compact .round { width: 44px; height: 44px; font-size: 1.6rem; }
    .compact .round.plus { width: 40px; height: 49px; box-shadow: inset -3px -4px 0 rgba(0,0,0,0.10); }
    .head.bare { justify-content: center; }
    .grid { gap: 12px; }
    .grid .foot { align-items: baseline; text-wrap: balance; }
    .tray { display: grid; gap: 6px; padding: 10px 10px 12px; border-radius: 16px; background: color-mix(in srgb, var(--primary-text-color) 6%, transparent); }
    .names, .cells { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); justify-items: center; }
    .names span { font-size: 0.7rem; color: var(--secondary-text-color); }
    .cells { row-gap: 6px; }
    .cell { position: relative; width: 100%; max-width: 46px; aspect-ratio: 4 / 5; padding: 0; border: 0; background: none; display: grid; place-items: center; border-radius: var(--et-egg); }
    .shell { width: 82%; height: 82%; display: grid; place-items: center; border-radius: var(--et-egg); box-sizing: border-box;
      font-family: var(--et-round); font-size: 0.95rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
    .egg .shell { color: var(--et-ink);
      background: radial-gradient(circle at 34% 26%, rgba(255,255,255,0.6), transparent 44%), var(--et-shell-rich);
      background: radial-gradient(circle at 34% 26%, rgba(255,255,255,0.6), transparent 44%), color-mix(in oklab, var(--et-shell-rich) calc(var(--t, 1) * 100%), var(--et-shell-pale));
      box-shadow: inset -3px -4px 0 rgba(0,0,0,0.10), 0 2px 3px rgba(0,0,0,0.25); }
    .none .shell { color: var(--secondary-text-color); font-weight: 600; border: 1.5px solid color-mix(in srgb, var(--secondary-text-color) 55%, transparent); }
    .gap .shell { border: 1.5px dotted color-mix(in srgb, var(--secondary-text-color) 45%, transparent); }
    .cell.sel { outline: 2px solid var(--et-accent); outline-offset: 1px; }
    .cell.now:not(.sel)::after { content: ""; position: absolute; bottom: -4px; width: 5px; height: 5px; border-radius: 50%; background: var(--et-accent); }
    button.cell:hover .shell { filter: brightness(1.08); }
    .mon { position: absolute; top: -3px; left: -2px; z-index: 1; font-size: 0.6rem; line-height: 1; padding: 2px 4px; border-radius: 6px;
      color: var(--primary-text-color); background: var(--card-background-color, var(--secondary-background-color)); }
    .cell.pop .shell { animation: et-pop 0.32s cubic-bezier(0.3, 1.6, 0.5, 1); }
    @keyframes et-pop { 0% { transform: scale(0.72) translateY(-6px); } 100% { transform: scale(1) translateY(0); } }
    .compact .n { font-size: 2.2rem; line-height: 1; }
    .compact .exact { font-size: 1.8rem; }
    .compact .unit { font-size: 0.78rem; }
    .compact .count { min-width: 96px; }
    .sub, .state, .foot { font-size: 0.82rem; color: var(--secondary-text-color); text-align: center; }
    .compact .sub, .compact .err { font-size: 0.75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .state { margin-top: -8px; }
    .foot { display: flex; justify-content: space-between; gap: 12px; text-align: left; }
    .link { background: none; border: 0; padding: 0; color: var(--primary-color); font-size: inherit; text-decoration: underline; text-underline-offset: 2px; }
    .link.quiet { color: var(--secondary-text-color); }
    .actions { display: flex; gap: 14px; flex: none; }
    .err { font-size: 0.85rem; color: var(--error-color, #db4437); text-align: center; }
    .chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 8px; }
    .chips span { background: var(--secondary-background-color); border-radius: 999px; padding: 4px 11px; font-size: 0.8rem; color: var(--secondary-text-color); }
    .chips b { color: var(--primary-text-color); font-weight: 600; }
    .chart { display: flex; align-items: stretch; gap: 3px; height: 132px; }
    .bar { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: stretch; gap: 3px; background: none; border: 0; border-radius: 6px; padding: 2px 0; }
    .bar .v { height: 14px; font-size: 0.68rem; line-height: 14px; text-align: center; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
    .bar .col { flex: 1; display: flex; align-items: flex-end; border-bottom: 1px solid var(--divider-color); }
    .bar i { display: block; width: 100%; border-radius: 4px 4px 0 0; background: var(--et-accent); background: color-mix(in srgb, var(--et-accent) 55%, transparent); }
    .bar .d { height: 14px; font-size: 0.68rem; line-height: 14px; text-align: center; color: var(--secondary-text-color); }
    .bar.unlogged .col { border-bottom-style: dashed; }
    .bar:hover i { background: color-mix(in srgb, var(--et-accent) 80%, transparent); }
    .bar.sel i { background: var(--et-accent); }
    .bar.sel .col { border-bottom-color: var(--et-accent); border-bottom-width: 2px; }
    .bar.sel .v, .bar.sel .d { color: var(--primary-text-color); font-weight: 700; }
    .bar.dense { gap: 2px; }
    .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    .tiles div { background: var(--secondary-background-color); border-radius: 10px; padding: 8px 10px; display: grid; gap: 1px; min-width: 0; align-content: start; }
    .tiles span { font-size: 0.72rem; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tiles b { font-size: 1.25rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .tiles small { font-size: 0.7rem; color: var(--secondary-text-color); }
    .note { width: 100%; box-sizing: border-box; font: inherit; font-size: 0.9rem; color: var(--primary-text-color); background: var(--secondary-background-color);
      border: 1px solid transparent; border-radius: 10px; padding: 9px 12px; }
    .note::placeholder { color: var(--secondary-text-color); opacity: 0.8; }
    .note:focus, .exact:focus { outline: none; border-color: var(--et-accent); }
    button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    @container (max-width: 380px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } .counter { gap: 12px; } .foot { flex-direction: column; gap: 4px; } }
    @container (max-width: 300px) { .et:not(.compact) .counter { gap: 8px; } .et:not(.compact) .count { min-width: 84px; }
      .et:not(.compact) .round { width: 50px; height: 50px; } .et:not(.compact) .round.plus { width: 46px; height: 56px; } .n { font-size: 3rem; } .tray { padding: 8px 6px 10px; } }
    @media (prefers-reduced-motion: reduce) { .round { transition: none; } .cell.pop .shell { animation: none; } }
    `;
  }
}

if (!customElements.get("egg-track-card")) customElements.define("egg-track-card", EggTrackCard);
window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === "egg-track-card")) {
  window.customCards.push({ type: "egg-track-card", name: "Egg Track", description: "Log the eggs your chickens lay each day, with a chart and totals.", preview: false, documentationURL: "https://github.com/ClermontDigital/EggTrack" });
}
console.info(`%c EGG-TRACK-CARD %c ${ET_VERSION} `, "background:#F2B544;color:#3A2A00;border-radius:3px 0 0 3px", "background:#5A4520;color:#fff;border-radius:0 3px 3px 0");
