/* Egg Track card - log the eggs your chickens lay each day.
 * Buildless: plain JS custom element, served by the egg_track integration.
 * Colours come from the Home Assistant theme; set --egg-track-accent to change the yolk colour.
 */
const ET_VERSION = "0.1.0";

const ET_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ET_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const etEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const etParse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const etIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const etShift = (s, n) => { const d = etParse(s); d.setDate(d.getDate() + n); return etIso(d); };
const etShort = (s) => { const d = etParse(s); return `${d.getDate()} ${ET_MONTHS[d.getMonth()]}`; };
const etLong = (s) => { const d = etParse(s); return `${ET_WEEKDAYS[d.getDay()]} ${d.getDate()} ${ET_MONTHS[d.getMonth()]}`; };
const etNum = (n) => Number(n).toLocaleString();
const etDec = (n) => (Number.isInteger(+n) ? String(+n) : (+n).toFixed(1));
const etEggs = (n) => (n === 1 ? "egg" : "eggs");

class EggTrackCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { view: "full", days: 14 };
    this._selected = null;   // the day being looked at; null = today
    this._editing = false;   // typing an exact count
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
    this.shadowRoot.addEventListener("keydown", (ev) => this._onKey(ev));
    this.shadowRoot.addEventListener("focusout", (ev) => { if (ev.target.classList?.contains("exact")) this._commitExact(ev.target); });
    // Redrawing while a finger is down on a button would swallow the tap, so a redraw waits for the release.
    this.shadowRoot.addEventListener("pointerdown", () => { this._pressing = true; });
    this._release = () => {
      this._pressing = false;
      if (this._renderQueued) { this._renderQueued = false; setTimeout(() => this._render(), 0); }
    };
  }

  setConfig(config) {
    const days = Number(config?.days ?? 14);
    if (config?.view && !["full", "compact"].includes(config.view)) throw new Error("Egg Track: view must be full or compact");
    if (!Number.isInteger(days) || days < 7 || days > 60) throw new Error("Egg Track: days must be a whole number from 7 to 60");
    const flockChanged = (config?.entry_id || null) !== (this._config.entry_id || null);
    this._config = { view: "full", ...config, days };
    if (flockChanged) { this._unsubscribe(); this._entryId = null; this._data = null; }
    if (this._hass) this._load();
  }

  static getStubConfig() { return {}; }

  static getConfigForm() {
    const labels = { entry_id: "Flock", view: "Layout", days: "Days in the chart", title: "Title" };
    const helpers = { entry_id: "Leave empty to use your first flock.", title: "Leave empty to use the flock's name." };
    return {
      schema: [
        { name: "entry_id", selector: { config_entry: { integration: "egg_track" } } },
        { name: "view", selector: { select: { mode: "dropdown", options: [{ value: "full", label: "Full" }, { value: "compact", label: "Compact" }] } } },
        { name: "days", selector: { number: { min: 7, max: 60, step: 1, mode: "box" } } },
        { name: "title", selector: { text: {} } },
      ],
      computeLabel: (schema) => labels[schema.name],
      computeHelper: (schema) => helpers[schema.name],
    };
  }

  getCardSize() { return this._config.view === "compact" ? 2 : 7; }
  getGridOptions() {
    return this._config.view === "compact" ? { columns: 6, rows: 2, min_columns: 4, min_rows: 2 } : { columns: 12, rows: "auto", min_columns: 6 };
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) { this._load(); return; }
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
    if (this._hass && this._entryId) { this._subscribe(); this._load(); }
  }

  disconnectedCallback() {
    window.removeEventListener("pointerup", this._release, true);
    window.removeEventListener("pointercancel", this._release, true);
    this._pressing = false;
    this._unsubscribe();
  }

  _ws(msg) { return this._hass.callWS(msg); }

  async _load() {
    if (this._pending) return;   // taps still on their way: the last one reloads
    const seq = (this._seq = (this._seq || 0) + 1);
    try {
      if (!this._entryId) {
        if (this._config.entry_id) this._entryId = this._config.entry_id;
        else {
          const flocks = await this._ws({ type: "egg_track/flocks" });
          if (!flocks.length) { this._data = null; this._empty = true; this._error = null; this._render(); return; }
          this._entryId = flocks[0].entry_id;
        }
      }
      const msg = { type: "egg_track/overview", entry_id: this._entryId, days: this._config.days };
      if (this._selected) msg.date = this._selected;
      const data = await this._ws(msg);
      if (seq !== this._seq) return;   // a newer request is on its way
      this._data = data;
      this._empty = false;
      this._error = null;
      this._clockDay = etIso(new Date());
      if (!this._unsub && this.isConnected) this._subscribe();
    } catch (err) {
      if (seq !== this._seq) return;
      this._error = err?.message || String(err);
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

  get _day() { return this._selected || this._data.today; }

  async _send(msg) {
    try {
      await this._ws({ entry_id: this._entryId, date: this._day, ...msg });
      this._error = null;
    } catch (err) {
      this._error = err?.message || String(err);
    }
    await this._load();
  }

  async _add(count) {
    const day = this._data.day;   // show the change straight away; the reload after the last tap confirms it
    day.eggs = Math.max(0, day.eggs + count);
    day.logged = true;
    this._render();
    this._pending = (this._pending || 0) + 1;
    try {
      await this._ws({ type: "egg_track/add", entry_id: this._entryId, date: day.date, count });
      this._error = null;
    } catch (err) {
      this._error = err?.message || String(err);
    }
    this._pending -= 1;
    if (!this._pending) await this._load();
  }

  _commitExact(input) {
    if (!this._editing) return;
    this._editing = false;
    const value = Number(input.value);
    if (input.value.trim() === "" || !Number.isInteger(value) || value < 0 || value === this._data.day.eggs && this._data.day.logged) { this._render(); return; }
    this._send({ type: "egg_track/set_day", eggs: value });
  }

  _onKey(ev) {
    if (!ev.target.classList?.contains("exact")) return;
    if (ev.key === "Enter") { ev.preventDefault(); this._commitExact(ev.target); }
    if (ev.key === "Escape") { this._editing = false; this._render(); }
  }

  _onChange(ev) {
    if (ev.target.classList?.contains("note")) this._send({ type: "egg_track/set_day", note: ev.target.value });
  }

  _onClick(ev) {
    const bar = ev.target.closest("[data-date]");
    if (bar) { this._select(bar.dataset.date); return; }
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "retry") { this._load(); return; }
    if (!this._data) return;
    if (act === "plus") this._add(1);
    else if (act === "minus") this._add(-1);
    else if (act === "none") this._send({ type: "egg_track/set_day", eggs: 0 });
    else if (act === "clear") this._send({ type: "egg_track/clear_day" });
    else if (act === "prev") this._select(etShift(this._day, -1));
    else if (act === "next") this._select(etShift(this._day, 1));
    else if (act === "today") this._select(this._data.today);
    else if (act === "export") this._export();
    else if (act === "edit") {
      this._editing = true;
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
      const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
      const rows = ["date,eggs,note", ...Object.entries(days).map(([d, r]) => `${d},${r.eggs},${quote(r.note || "")}`)];
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([rows.join("\n") + "\n"], { type: "text/csv" }));
      link.download = `egg-track-${(this._data.flock.name || "flock").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (err) {
      this._error = err?.message || String(err);
      this._render();
    }
  }

  _render() {
    if (this._pressing) { this._renderQueued = true; return; }
    const root = this.shadowRoot;
    // Keep a half-typed note through a refresh triggered by someone else logging an egg.
    const typing = root.activeElement?.classList?.contains("note") ? { value: root.activeElement.value, at: root.activeElement.selectionStart } : null;
    root.innerHTML = `<style>${EggTrackCard.styles}</style><ha-card>${this._body()}</ha-card>`;
    if (typing) {
      const note = root.querySelector(".note");
      if (note) { note.value = typing.value; note.focus(); try { note.setSelectionRange(typing.at, typing.at); } catch (_) { /* not a text field */ } }
    }
  }

  _body() {
    if (this._empty) {
      return `<div class="et msg"><ha-icon icon="mdi:egg-outline"></ha-icon><p>No flock yet. Add one in Settings, Devices &amp; services, Add integration, <b>Egg Track</b>.</p><button class="link" data-act="retry">Check again</button></div>`;
    }
    if (!this._data) {
      return this._error
        ? `<div class="et msg"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><p>${etEsc(this._error)}</p><button class="link" data-act="retry">Try again</button></div>`
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
        <button class="round" data-act="minus" aria-label="Remove an egg"><span>−</span></button>
        <div class="count">${count}<span class="unit">${etEggs(day.eggs)} ${when}</span></div>
        <button class="round plus" data-act="plus" aria-label="Add an egg"><span>+</span></button>
      </div>`;
    const error = this._error ? `<div class="err" role="alert">${etEsc(this._error)}</div>` : "";

    if (this._config.view === "compact") {
      const bits = [];
      if (stats.daily_average != null) bits.push(`${etDec(stats.daily_average)} a day`);
      bits.push(`${etNum(stats.last_7_days)} in 7 days`);
      return `<div class="et compact"><div class="head"><div class="title"><ha-icon icon="mdi:egg"></ha-icon><span>${title}</span></div></div>${counter}<div class="sub">${bits.join(" · ")}</div>${error}</div>`;
    }

    const chips = [];
    if (stats.daily_average != null) chips.push(`<span><b>${etDec(stats.daily_average)}</b> a day, 7-day average</span>`);
    if (stats.lay_rate != null) chips.push(`<span><b>${Math.round(stats.lay_rate)}%</b> lay rate from ${flock.hens} ${flock.hens === 1 ? "hen" : "hens"}</span>`);
    if (stats.streak > 1) chips.push(`<span><b>${stats.streak}</b> days in a row</span>`);

    const state = day.logged ? "" : `<div class="state"><span>Not logged yet.</span> <button class="link" data-act="none">No eggs ${isToday ? "today" : "this day"}</button></div>`;
    const clear = day.logged ? `<button class="link quiet" data-act="clear" title="Forget this day's count and note">Clear this day</button>` : "";
    const dozens = stats.all_time >= 12 ? `<small>${etDec(Math.round(stats.all_time / 1.2) / 10)} dozen</small>` : "";
    const best = stats.best_day ? `Best day: ${stats.best_eggs} on ${etShort(stats.best_day)}` : "";

    return `
      <div class="et">
        <div class="head">
          <div class="title"><ha-icon icon="mdi:egg"></ha-icon><span>${title}</span></div>
          <div class="nav">
            <button class="icon" data-act="prev" aria-label="Previous day">‹</button>
            <button class="day" data-act="today" ${isToday ? "disabled" : ""} title="${isToday ? "" : "Back to today"}">${isToday ? "Today" : etLong(day.date)}</button>
            <button class="icon" data-act="next" aria-label="Next day" ${isToday ? "disabled" : ""}>›</button>
          </div>
        </div>
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
        <input class="note" type="text" maxlength="200" placeholder="Note for ${isToday ? "today" : etShort(day.date)} (optional)" aria-label="Note for ${isToday ? "today" : etLong(day.date)}" value="${etEsc(day.note)}">
        <div class="foot"><span>${best}</span><span class="actions">${clear}<button class="link" data-act="export">Export CSV</button></span></div>
      </div>`;
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
    :host { --et-accent: var(--egg-track-accent, #F2B544); --et-on-accent: #3A2A00; }
    ha-card { overflow: hidden; container-type: inline-size; }
    .et { padding: 16px; color: var(--primary-text-color); display: grid; gap: 14px; font-family: var(--paper-font-body1_-_font-family, inherit); }
    .et.compact { gap: 6px; padding: 12px 14px; }
    .msg { justify-items: center; text-align: center; color: var(--secondary-text-color); padding: 28px 16px; }
    .msg ha-icon { --mdc-icon-size: 36px; color: var(--et-accent); }
    .msg p { margin: 0; max-width: 34ch; line-height: 1.45; }
    button { font: inherit; color: inherit; cursor: pointer; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
    .title { display: flex; align-items: center; gap: 8px; font-size: 1.1rem; font-weight: 600; min-width: 0; }
    .title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title ha-icon { color: var(--et-accent); flex: none; }
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
    .round.plus { background: var(--et-accent); color: var(--et-on-accent); }
    .round:hover { background: color-mix(in srgb, var(--et-accent) 18%, transparent); }
    .round.plus:hover { background: color-mix(in srgb, var(--et-accent) 86%, #fff); }
    .round:active { transform: scale(0.94); }
    .count { display: grid; justify-items: center; min-width: 112px; }
    .n { background: none; border: 0; padding: 0 8px; font-size: 3.4rem; font-weight: 700; line-height: 1.05; font-variant-numeric: tabular-nums; border-radius: 10px; }
    .n:hover { background: var(--secondary-background-color); }
    .exact { width: 5.2ch; font: inherit; font-size: 2.6rem; font-weight: 700; text-align: center; color: var(--primary-text-color);
      background: var(--secondary-background-color); border: 2px solid var(--et-accent); border-radius: 10px; padding: 2px 4px; }
    .unit { font-size: 0.85rem; color: var(--secondary-text-color); }
    .compact .round { width: 46px; height: 46px; font-size: 1.6rem; }
    .compact .n { font-size: 2.4rem; }
    .compact .count { min-width: 96px; }
    .sub, .state, .foot { font-size: 0.82rem; color: var(--secondary-text-color); text-align: center; }
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
    .tiles div { background: var(--secondary-background-color); border-radius: 10px; padding: 8px 10px; display: grid; gap: 1px; min-width: 0; }
    .tiles span { font-size: 0.72rem; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tiles b { font-size: 1.25rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .tiles small { font-size: 0.7rem; color: var(--secondary-text-color); }
    .note { width: 100%; box-sizing: border-box; font: inherit; font-size: 0.9rem; color: var(--primary-text-color); background: var(--secondary-background-color);
      border: 1px solid transparent; border-radius: 10px; padding: 9px 12px; }
    .note::placeholder { color: var(--secondary-text-color); opacity: 0.8; }
    .note:focus, .exact:focus { outline: none; border-color: var(--et-accent); }
    button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    @container (max-width: 380px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } .counter { gap: 12px; } .foot { flex-direction: column; gap: 4px; } }
    @media (prefers-reduced-motion: reduce) { .round { transition: none; } }
    `;
  }
}

if (!customElements.get("egg-track-card")) customElements.define("egg-track-card", EggTrackCard);
window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === "egg-track-card")) {
  window.customCards.push({ type: "egg-track-card", name: "Egg Track", description: "Log the eggs your chickens lay each day, with a chart and totals.", preview: false, documentationURL: "https://github.com/ClermontDigital/EggTrack" });
}
console.info(`%c EGG-TRACK-CARD %c ${ET_VERSION} `, "background:#F2B544;color:#3A2A00;border-radius:3px 0 0 3px", "background:#5A4520;color:#fff;border-radius:0 3px 3px 0");
