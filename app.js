'use strict';

// Währungsliste und Notfall-Kurse: currencies.js
// Kurse werden wie von den Quellen geliefert als "1 EUR = x Währung" gespeichert.
// Gerechnet wird über die eigene Währung (state.home).
const CODES = Object.keys(CURRENCIES);
const DEFAULT_HOME = 'EUR';
const DEFAULT_SELECTED = ['THB', 'LAK', 'KHR', 'USD'];

const STORAGE_KEY = 'fx-state-v1';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_DIGITS = 11;

const SOURCES = [
  {
    name: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/EUR',
    parse: d => (d.result === 'success' ? d.rates : null),
  },
  {
    name: 'fawazahmed0/currency-api',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json',
    parse: d => (d.eur ? Object.fromEntries(CODES.map(c => [c, d.eur[c.toLowerCase()]])) : null),
  },
];

let state = {
  rates: { ...DEFAULT_RATES },
  fetchedAt: null,     // ms-Zeitstempel der letzten erfolgreichen Online-Abfrage
  source: null,
  home: DEFAULT_HOME,  // eigene Währung
  selected: [...DEFAULT_SELECTED], // Reiseländer = Tabs im Rechner
  local: 'THB',        // gewählte Landeswährung im Rechner (eine aus selected)
  overrides: {},       // eigene Kurse je eigener Währung: { EUR: { THB: 36.5 } } heißt 1 € = 36,5 ฿
  toHome: true,        // true: Eingabe in Landeswährung, Ergebnis in eigener Währung
  entry: '0',          // Eingabe als Text, Komma als Dezimaltrenner
  inverse: false,      // Einstellungen: Kurs als "1 X = … eigene Währung"
};
let statusError = null;
let loading = false;
let migrated = false;  // Daten aus Version 1: Kurse der neuen Währungen bald online holen

// ---------- Persistenz ----------

function load() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (e) { /* ohne Speicher weiter mit Defaults */ }
  if (saved && typeof saved === 'object') {
    // Version 1 kannte nur Euro: Richtung hieß toEur, eigene Kurse galten für Euro.
    if (!saved.home) {
      migrated = true;
      if ('toEur' in saved) saved.toHome = saved.toEur;
      if (saved.overrides) saved.overrides = { EUR: saved.overrides };
    }
    state = { ...state, ...saved, rates: { ...DEFAULT_RATES, ...saved.rates } };
  }
  // Felder älterer Versionen aufräumen
  for (const key of ['active', 'amount', 'country', 'toEur']) delete state[key];
  if (!CURRENCIES[state.home]) state.home = DEFAULT_HOME;
  if (!Array.isArray(state.selected)) state.selected = [];
  state.selected = state.selected.filter((c, i, all) => CURRENCIES[c] && c !== state.home && all.indexOf(c) === i);
  if (!state.selected.length) state.selected = DEFAULT_SELECTED.filter(c => c !== state.home);
  if (!state.selected.includes(state.local)) state.local = state.selected[0];
  if (!state.overrides || typeof state.overrides !== 'object') state.overrides = {};
  if (typeof state.entry !== 'string' || !/^\d+(,\d*)?$/.test(state.entry)) state.entry = '0';
  fitEntry();
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignorieren */ }
}

// ---------- Rechnen & Formatieren ----------

function eurRate(code) {
  return code === 'EUR' ? 1 : state.rates[code];
}

// Online-Kurs: 1 eigene Währung = x code
function marketRate(code) {
  return eurRate(code) / eurRate(state.home);
}

function homeOverrides() {
  return state.overrides[state.home] || {};
}

// Gültiger Kurs: 1 eigene Währung = x code (eigener Kurs vor Online-Kurs)
function rate(code) {
  if (code === state.home) return 1;
  return homeOverrides()[code] ?? marketRate(code);
}

function setOverride(code, value) {
  if (!state.overrides[state.home]) state.overrides[state.home] = {};
  state.overrides[state.home][code] = value;
}

function inCode() { return state.toHome ? state.local : state.home; }
function outCode() { return state.toHome ? state.home : state.local; }

// Eigene Währung und Reiseländer – alles, was gerade auf dem Bildschirm vorkommt
function activeCodes() { return [state.home, ...state.selected]; }

// Haben zwei aktive Währungen dasselbe Symbol (z. B. „kr“ in Schweden und Norwegen), steht dort der Code.
function sym(code) {
  const s = CURRENCIES[code].sym;
  return activeCodes().some(c => c !== code && CURRENCIES[c].sym === s) ? code : s;
}

function flag(code) {
  const cc = CURRENCIES[code].cc;
  if (!/^[A-Z]{2}$/.test(cc)) return cc;
  return String.fromCodePoint(...[...cc].map(ch => 0x1F1A5 + ch.charCodeAt(0)));
}

const esc = text => text.replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`);

function format(value, decimals) {
  if (!isFinite(value)) return '–';
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: decimals }).format(value);
}

// Ergebnisbeträge immer mit vollen Nachkommastellen: "0,20 €" statt "0,2 €"
function formatMoney(value, decimals) {
  if (!isFinite(value)) return '–';
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatRate(value) {
  const digits = value >= 100 ? 0 : value >= 10 ? 2 : value >= 1 ? 4 : 6;
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(value);
}

// Akzeptiert "1.234,5", "1234.5", "24.928" usw. (Eingabefelder in den Einstellungen)
function parseNumber(text) {
  let s = String(text).replace(/[\s ']/g, '');
  if (!s) return NaN;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? n : NaN;
}

function entryValue() {
  return parseFloat(state.entry.replace(',', '.')) || 0;
}

// "1234,5" -> "1.234,5" (Nachkommastellen bleiben wie getippt)
function entryText(entry) {
  const [int, frac] = entry.split(',');
  const s = format(parseInt(int || '0', 10), 0);
  return frac === undefined ? s : `${s},${frac}`;
}

function toEntry(value, dec) {
  let s = value.toFixed(dec);
  if (dec > 0) s = s.replace(/\.?0+$/, '');
  return s.replace('.', ',');
}

// Eingabe an die Nachkommastellen der Eingabewährung anpassen (z. B. nach Wechsel der eigenen Währung)
function fitEntry() {
  const dec = CURRENCIES[inCode()].dec;
  const [int, frac] = state.entry.split(',');
  state.entry = frac === undefined || dec === 0 ? int : `${int},${frac.slice(0, dec)}`;
}

function sizeClass(text) {
  const n = text.length;
  return n <= 8 ? '' : n <= 10 ? 'm' : n <= 12 ? 's' : 'xs';
}

// ---------- Eingabe ----------

function press(key) {
  const dec = CURRENCIES[inCode()].dec;
  let e = state.entry;
  if (key === 'clear') {
    e = '0';
  } else if (key === 'back') {
    e = e.length > 1 ? e.slice(0, -1) : '0';
  } else if (key === ',') {
    if (dec > 0 && !e.includes(',')) e += ',';
  } else if (key === '000') {
    if (e !== '0' && !e.includes(',') && e.length + 3 <= MAX_DIGITS) e += '000';
  } else if (e === '0') {
    e = key;
  } else {
    const frac = e.split(',')[1];
    if (e.replace(',', '').length < MAX_DIGITS && (frac === undefined || frac.length < dec)) e += key;
  }
  if (e === state.entry) return;
  state.entry = e;
  save();
  renderCalc();
}

function setEntry(entry) {
  state.entry = entry;
  save();
  renderCalc();
}

function selectCountry(code) {
  state.local = code;
  // Neuer Preis vor Ort: Eingabe leeren. Bei Eingabe in eigener Währung den Betrag behalten.
  if (state.toHome) state.entry = '0';
  save();
  renderCalc();
}

// Weitere Währung antippen: wird zur Landeswährung, der Wert bleibt gleich.
function selectLocal(code) {
  if (state.toHome) {
    const value = entryValue() / rate(state.local) * rate(code);
    state.entry = toEntry(value, CURRENCIES[code].dec);
  }
  state.local = code;
  save();
  renderCalc();
}

function swap() {
  const out = entryValue() / rate(inCode()) * rate(outCode());
  state.entry = toEntry(out, CURRENCIES[outCode()].dec);
  state.toHome = !state.toHome;
  $('btn-swap').classList.toggle('turned');
  save();
  renderCalc();
}

// ---------- Rechner-Ansicht ----------

const $ = id => document.getElementById(id);

function setAmount(box, numEl, text) {
  numEl.textContent = text;
  box.classList.remove('m', 's', 'xs');
  const cls = sizeClass(text);
  if (cls) box.classList.add(cls);
}

// Tabs nur neu bauen, wenn sich die Reiseländer ändern (sonst springt die Scroll-Position).
let tabsKey = '';

function renderTabs() {
  const tabs = $('tabs');
  const key = state.selected.join();
  if (key !== tabsKey) {
    tabsKey = key;
    tabs.innerHTML = state.selected
      .map(code => `<button role="tab" data-code="${code}">${CURRENCIES[code].land}</button>`)
      .join('');
    tabs.hidden = state.selected.length < 2;
  }
  let selected = null;
  for (const b of tabs.children) {
    const on = b.dataset.code === state.local;
    b.setAttribute('aria-selected', String(on));
    if (on) selected = b;
  }
  // Viele Länder: Leiste scrollt. Gewählten Tab mittig zeigen, damit die Nachbarn angeschnitten
  // sichtbar bleiben und man sieht, dass es weitergeht.
  if (selected && tabs.scrollWidth > tabs.clientWidth) {
    tabs.scrollLeft = selected.offsetLeft + selected.offsetWidth / 2 - tabs.clientWidth / 2;
  }
}

function renderCalc() {
  const inC = inCode();
  const outC = outCode();
  const home = entryValue() / rate(inC); // Betrag in eigener Währung
  const out = home * rate(outC);

  renderTabs();

  $('in-name').textContent = CURRENCIES[inC].name;
  $('in-sym').textContent = sym(inC);
  setAmount($('in-amount'), $('in-num'), entryText(state.entry));
  $('in-amount').classList.toggle('empty', state.entry === '0');
  $('btn-clear').hidden = state.entry === '0';

  $('out-name').textContent = CURRENCIES[outC].name;
  $('out-sym').textContent = sym(outC);
  setAmount($('out-amount'), $('out-num'), formatMoney(out, CURRENCIES[outC].dec));

  $('others').innerHTML = state.selected
    .filter(code => code !== state.local)
    .map(code => {
      const c = CURRENCIES[code];
      const text = `${formatMoney(home * rate(code), c.dec)} ${sym(code)}`;
      return `<button data-code="${code}" aria-label="${text} – ${c.name} verwenden">≈ ${text}</button>`;
    })
    .join('');

  // Sehr kleine Kurse umgedreht zeigen: "1 € = 28.994 ₫" statt "1 ₫ = 0,000034 €"
  const r = rate(state.local);
  const [from, to, value] = r >= 0.01 ? [state.home, state.local, r] : [state.local, state.home, 1 / r];
  const manual = homeOverrides()[state.local] != null;
  $('rate-line').innerHTML = `1 ${sym(from)} = ${formatRate(value)} ${sym(to)}` +
    (manual ? ' · <span class="manual">eigener Kurs</span>' : '');

  $('chips').innerHTML = CURRENCIES[inC].quick
    .map(q => `<button data-value="${q}">${format(q, 0)} ${sym(inC)}</button>`)
    .join('');

  const decKey = $('key-dec');
  if (CURRENCIES[inC].dec > 0) {
    decKey.dataset.key = ',';
    decKey.textContent = ',';
    decKey.setAttribute('aria-label', 'Komma');
  } else {
    decKey.dataset.key = '000';
    decKey.textContent = '000';
    decKey.setAttribute('aria-label', 'Drei Nullen');
  }

  renderStatus();
}

function statusLabel() {
  if (!state.fetchedAt) return 'Standardkurse';
  const d = new Date(state.fetchedAt);
  const startOfDay = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 864e5);
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `Heute, ${time}`;
  if (days === 1) return `Gestern, ${time}`;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
}

function renderStatus() {
  const btn = $('btn-refresh');
  let text = loading ? 'Lädt …' : statusLabel();
  if (!loading && statusError) text = statusError;
  else if (!loading && !navigator.onLine) text += ' · offline';
  $('status-text').textContent = text;
  btn.classList.toggle('loading', loading);
  btn.classList.toggle('error', !loading && !!statusError);
  btn.setAttribute('aria-label', `Kurse aktualisieren. Stand: ${statusLabel()}`);

  const btn2 = $('btn-refresh-2');
  btn2.disabled = loading;
  btn2.classList.toggle('loading', loading);
  const src = $('source-line');
  src.textContent = statusError
    ? `${statusError}. Es gelten die gespeicherten Kurse (${statusLabel()}).`
    : state.fetchedAt
      ? `Online-Kurse von ${state.source} · ${statusLabel()}`
      : 'Eingebaute Standardkurse (Okt. 2026) – bitte online aktualisieren.';
  src.classList.toggle('error', !!statusError);
}

// ---------- Online-Kurse ----------

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshRates() {
  if (loading) return;
  loading = true;
  statusError = null;
  renderStatus();
  try {
    const valid = n => typeof n === 'number' && isFinite(n) && n > 0;
    for (const src of SOURCES) {
      try {
        const rates = src.parse(await fetchJson(src.url));
        // Die Quelle muss alle gerade genutzten Währungen liefern; gespeichert werden alle,
        // damit später hinzugefügte Länder auch offline aktuelle Kurse haben.
        if (rates && activeCodes().every(c => c === 'EUR' || valid(rates[c]))) {
          for (const c of CODES) if (c !== 'EUR' && valid(rates[c])) state.rates[c] = rates[c];
          state.fetchedAt = Date.now();
          state.source = src.name;
          migrated = false;
          save();
          return;
        }
      } catch (e) { /* nächste Quelle probieren */ }
    }
    statusError = navigator.onLine ? 'Nicht aktualisiert' : 'Kein Internet';
  } finally {
    loading = false;
    renderCalc();
    if (!$('view-settings').hidden) renderSettings();
  }
}

function maybeAutoRefresh() {
  if (navigator.onLine && (migrated || !state.fetchedAt || Date.now() - state.fetchedAt > MAX_AGE_MS)) {
    refreshRates();
  }
}

// ---------- Einstellungen ----------

function renderSettings() {
  const home = CURRENCIES[state.home];
  const h = sym(state.home);
  $('home-flag').textContent = flag(state.home);
  $('home-name').textContent = home.name;
  $('home-sub').textContent = `${state.home} · ${home.land}`;

  const [perHome, perLocal] = $('dir-tabs').children;
  perHome.textContent = `1 ${h} = … Landeswährung`;
  perLocal.textContent = `1 Landeswährung = … ${h}`;
  for (const b of $('dir-tabs').children) {
    b.setAttribute('aria-selected', String((b.dataset.inverse === '1') === state.inverse));
  }

  const list = $('settings-list');
  list.innerHTML = '';
  for (const code of state.selected) {
    const c = CURRENCIES[code];
    const s = sym(code);
    const manual = homeOverrides()[code] != null;
    const r = rate(code);
    const online = marketRate(code);
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `
      <div class="set-top">
        <span class="badge flag" aria-hidden="true">${flag(code)}</span>
        <span class="set-name"><b>${c.land}</b><small>${c.name}</small></span>
        <label class="switch"><span>Eigener Kurs</span><input type="checkbox" role="switch" ${manual ? 'checked' : ''}></label>
      </div>
      <label class="set-rate">
        <span>1 ${state.inverse ? s : h} =</span>
        <input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" aria-label="Kurs für ${c.name}" ${manual ? '' : 'disabled'}>
        <span>${state.inverse ? h : s}</span>
      </label>
      ${manual ? `<div class="set-foot"><span>Online: ${state.inverse
        ? `1 ${s} = ${formatRate(1 / online)} ${h}`
        : `1 ${h} = ${formatRate(online)} ${s}`}</span><button type="button">Online-Kurs übernehmen</button></div>` : ''}`;

    const input = row.querySelector('.set-rate input');
    input.value = formatRate(state.inverse ? 1 / r : r);

    row.querySelector('.switch input').addEventListener('change', e => {
      if (e.target.checked) setOverride(code, marketRate(code));
      else delete homeOverrides()[code];
      save();
      renderSettings();
      if (e.target.checked) list.children[state.selected.indexOf(code)].querySelector('.set-rate input').focus();
    });
    input.addEventListener('change', () => {
      const n = parseNumber(input.value);
      if (n > 0) {
        setOverride(code, state.inverse ? 1 / n : n);
        save();
      }
      renderSettings();
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    const reset = row.querySelector('.set-foot button');
    if (reset) {
      reset.addEventListener('click', () => {
        setOverride(code, marketRate(code));
        save();
        renderSettings();
      });
    }
    list.appendChild(row);
  }
  renderStatus();
}

// Wird ein Reiseland zur eigenen Währung, rückt die bisherige eigene Währung an seine Stelle.
function setHome(code) {
  if (code === state.home) return;
  const i = state.selected.indexOf(code);
  if (i >= 0) state.selected[i] = state.home;
  if (state.local === code) state.local = state.home;
  state.home = code;
  state.entry = '0';
  save();
}

// Gibt einen Hinweis zurück, wenn das Land nicht abgewählt werden kann.
function toggleCountry(code) {
  const i = state.selected.indexOf(code);
  if (i < 0) {
    state.selected.push(code);
  } else if (state.selected.length === 1) {
    return 'Mindestens ein Reiseland muss ausgewählt bleiben.';
  } else {
    state.selected.splice(i, 1);
    if (state.local === code) {
      state.local = state.selected[0];
      if (state.toHome) state.entry = '0';
    }
  }
  save();
  return null;
}

// ---------- Länderauswahl ----------

const normalize = text => text.toLowerCase().replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[-.()]/g, ' ');
const BY_LAND = CODES.slice().sort((a, b) => CURRENCIES[a].land.localeCompare(CURRENCIES[b].land, 'de'));
const SEARCH_TEXT = Object.fromEntries(CODES.map(code => {
  const c = CURRENCIES[code];
  return [code, ` ${normalize(`${code} ${c.land} ${c.name} ${c.also || ''}`)}`];
}));

// mode 'travel': Reiseländer an- und abwählen; mode 'home': eigene Währung wählen
const picker = { mode: 'travel', pinned: [], scrollY: 0 };

function openPicker(mode) {
  picker.mode = mode;
  picker.pinned = mode === 'travel' ? [...state.selected] : [state.home];
  picker.scrollY = window.scrollY;
  $('picker-search').value = '';
  showView('picker');
}

function closePicker() {
  showView('settings');
  window.scrollTo(0, picker.scrollY);
}

// Treffer: Code, dann Ländername am Anfang, dann Wortanfang, dann irgendwo im Text
function search(query) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const first = words[0];
  const rank = code => {
    if (code.toLowerCase() === first) return 0;
    if (normalize(CURRENCIES[code].land).startsWith(first)) return 1;
    return SEARCH_TEXT[code].includes(` ${first}`) ? 2 : 3;
  };
  return BY_LAND
    .filter(code => words.every(w => SEARCH_TEXT[code].includes(w)))
    .sort((a, b) => rank(a) - rank(b));
}

function pickRow(code) {
  const c = CURRENCIES[code];
  const travel = picker.mode === 'travel';
  const isHome = travel && code === state.home;
  const on = travel ? state.selected.includes(code) : code === state.home;
  return `<button class="pick-row" data-code="${code}" aria-pressed="${on}"${isHome ? ' disabled' : ''}>
      <span class="badge flag" aria-hidden="true">${flag(code)}</span>
      <span class="set-name"><b>${c.land}</b><small>${code} · ${isHome ? 'Meine Währung' : c.name}</small></span>
      <svg class="check" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
    </button>`;
}

function renderPicker() {
  const travel = picker.mode === 'travel';
  $('picker-title').textContent = travel ? 'Reiseländer' : 'Meine Währung';
  $('picker-search').placeholder = travel ? 'Land oder Währung suchen' : 'Währung suchen';
  const group = (title, codes) =>
    `${title ? `<h2 class="section">${title}</h2>` : ''}<div class="group">${codes.map(pickRow).join('')}</div>`;
  const query = $('picker-search').value.trim();
  let html;
  if (query) {
    const hits = search(query);
    html = hits.length ? group('', hits) : `<p class="empty">Nichts gefunden für „${esc(query)}“.</p>`;
  } else {
    html = group(travel ? 'Ausgewählt' : 'Aktuell', picker.pinned) + group('Alle Länder', BY_LAND);
  }
  $('picker-list').innerHTML = html;
  renderPickerNote();
}

function renderPickerNote(warning) {
  const note = $('picker-note');
  const n = state.selected.length;
  note.textContent = warning || (picker.mode === 'travel'
    ? `${n} ${n === 1 ? 'Land' : 'Länder'} ausgewählt – sie erscheinen als Tabs im Rechner.`
    : 'In diese Währung rechnet die App alle Preise um.');
  note.classList.toggle('error', !!warning);
}

function pick(code) {
  if (picker.mode === 'home') {
    setHome(code);
    closePicker();
    return;
  }
  const warning = toggleCountry(code);
  for (const row of $('picker-list').querySelectorAll(`[data-code="${code}"]`)) {
    row.setAttribute('aria-pressed', String(state.selected.includes(code)));
  }
  renderPickerNote(warning);
}

// ---------- Ansichten ----------

function showView(name) {
  for (const view of ['calc', 'settings', 'picker']) $(`view-${view}`).hidden = view !== name;
  window.scrollTo(0, 0);
  if (name === 'calc') {
    fitEntry();
    renderCalc();
  } else if (name === 'settings') {
    renderSettings();
  } else {
    renderPicker();
  }
}

// ---------- Start ----------

load();
renderCalc();

$('tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) selectCountry(b.dataset.code);
});
$('others').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) selectLocal(b.dataset.code);
});
$('chips').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setEntry(b.dataset.value);
});
$('btn-clear').addEventListener('click', () => press('clear'));
$('btn-swap').addEventListener('click', swap);
$('btn-refresh').addEventListener('click', refreshRates);
$('btn-refresh-2').addEventListener('click', refreshRates);
$('btn-settings').addEventListener('click', () => showView('settings'));
$('btn-back').addEventListener('click', () => showView('calc'));
$('btn-home').addEventListener('click', () => openPicker('home'));
$('btn-countries').addEventListener('click', () => openPicker('travel'));
$('btn-picker-done').addEventListener('click', closePicker);
$('dir-tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.inverse = b.dataset.inverse === '1';
  save();
  renderSettings();
});
$('picker-list').addEventListener('click', e => {
  const b = e.target.closest('button[data-code]');
  if (b && !b.disabled) pick(b.dataset.code);
});
$('picker-search').addEventListener('input', () => {
  window.scrollTo(0, 0);
  renderPicker();
});
$('picker-search').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

// Tastatur: kurz tippen, Löschtaste lang drücken leert die Eingabe.
let holdTimer = null;
let held = false;
const keys = $('keys');
keys.addEventListener('pointerdown', e => {
  if (!e.target.closest('[data-key="back"]')) return;
  held = false;
  holdTimer = setTimeout(() => { held = true; press('clear'); }, 500);
});
for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
  keys.addEventListener(type, () => clearTimeout(holdTimer));
}
keys.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.key === 'back' && held) { held = false; return; }
  press(b.dataset.key);
});
keys.addEventListener('contextmenu', e => e.preventDefault());

// Hardware-Tastatur (Desktop)
document.addEventListener('keydown', e => {
  if ($('view-calc').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^[0-9]$/.test(e.key)) press(e.key);
  else if (e.key === ',' || e.key === '.') press(',');
  else if (e.key === 'Backspace') press('back');
  else if (e.key === 'Escape' || e.key === 'Delete') press('clear');
  else return;
  e.preventDefault();
});

window.addEventListener('online', () => { renderStatus(); maybeAutoRefresh(); });
window.addEventListener('offline', renderStatus);

maybeAutoRefresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
