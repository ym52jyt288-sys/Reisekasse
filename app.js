'use strict';

// Kurse sind immer "1 EUR = x Währung". Kreuzkurse laufen über EUR.
const CURRENCIES = {
  EUR: { sym: '€', name: 'Euro', dec: 2, quick: [10, 20, 50] },
  THB: { sym: '฿', name: 'Thailändischer Baht', dec: 2, quick: [100, 500, 1000] },
  LAK: { sym: '₭', name: 'Laotischer Kip', dec: 0, quick: [20000, 50000, 100000] },
  KHR: { sym: '៛', name: 'Kambodschanischer Riel', dec: 0, quick: [5000, 10000, 20000] },
  USD: { sym: '$', name: 'US-Dollar', dec: 2, quick: [1, 5, 10] },
};
const FOREIGN = Object.keys(CURRENCIES).filter(c => c !== 'EUR');
const COUNTRIES = ['THB', 'LAK', 'KHR']; // Tabs: Thailand, Laos, Kambodscha

// Notfall-Kurse für den allerersten Start ohne Internet (Stand 09.10.2026).
const DEFAULT_RATES = { THB: 37.71, LAK: 24928, KHR: 4543, USD: 1.1208 };

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
    parse: d => {
      if (!d.eur) return null;
      const out = {};
      for (const code of FOREIGN) out[code] = d.eur[code.toLowerCase()];
      return out;
    },
  },
];

let state = {
  rates: { ...DEFAULT_RATES },
  fetchedAt: null,     // ms-Zeitstempel der letzten erfolgreichen Online-Abfrage
  source: null,
  overrides: {},       // code -> manueller Kurs (1 EUR = x)
  country: 'THB',      // gewählter Länder-Tab
  local: 'THB',        // Landeswährung im Rechner (THB, LAK, KHR oder USD)
  toEur: true,         // true: Eingabe in Landeswährung, Ergebnis in EUR
  entry: '0',          // Eingabe als Text, Komma als Dezimaltrenner
  inverse: false,      // Einstellungen: Kurs als "1 X = … EUR"
};
let statusError = null;
let loading = false;

// ---------- Persistenz ----------

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch (e) { /* ohne Speicher weiter mit Defaults */ }
  // Felder älterer Versionen aufräumen
  delete state.active;
  delete state.amount;
  if (!FOREIGN.includes(state.local)) state.local = 'THB';
  if (!COUNTRIES.includes(state.country)) state.country = 'THB';
  if (typeof state.entry !== 'string' || !/^\d+(,\d*)?$/.test(state.entry)) state.entry = '0';
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignorieren */ }
}

// ---------- Rechnen & Formatieren ----------

function effectiveRate(code) {
  if (code === 'EUR') return 1;
  return state.overrides[code] ?? state.rates[code];
}

function inCode() { return state.toEur ? state.local : 'EUR'; }
function outCode() { return state.toEur ? 'EUR' : state.local; }

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
  state.country = code;
  state.local = code;
  // Neuer Preis vor Ort: Eingabe leeren. Bei Euro-Eingabe den Betrag behalten.
  if (state.toEur) state.entry = '0';
  save();
  renderCalc();
}

// Weitere Währung antippen: wird zur Landeswährung, der Wert bleibt gleich.
function selectLocal(code) {
  if (state.toEur) {
    const value = entryValue() / effectiveRate(state.local) * effectiveRate(code);
    state.entry = toEntry(value, CURRENCIES[code].dec);
  }
  state.local = code;
  if (COUNTRIES.includes(code)) state.country = code;
  save();
  renderCalc();
}

function swap() {
  const out = entryValue() / effectiveRate(inCode()) * effectiveRate(outCode());
  state.entry = toEntry(out, CURRENCIES[outCode()].dec);
  state.toEur = !state.toEur;
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

function renderCalc() {
  const inC = inCode();
  const outC = outCode();
  const eur = entryValue() / effectiveRate(inC);
  const out = eur * effectiveRate(outC);

  for (const b of $('tabs').children) {
    b.setAttribute('aria-selected', String(b.dataset.country === state.country));
  }

  $('in-name').textContent = CURRENCIES[inC].name;
  $('in-sym').textContent = CURRENCIES[inC].sym;
  setAmount($('in-amount'), $('in-num'), entryText(state.entry));
  $('in-amount').classList.toggle('empty', state.entry === '0');
  $('btn-clear').hidden = state.entry === '0';

  $('out-name').textContent = CURRENCIES[outC].name;
  $('out-sym').textContent = CURRENCIES[outC].sym;
  setAmount($('out-amount'), $('out-num'), formatMoney(out, CURRENCIES[outC].dec));

  $('others').innerHTML = FOREIGN
    .filter(code => code !== inC && code !== outC)
    .map(code => {
      const c = CURRENCIES[code];
      const text = `${formatMoney(eur * effectiveRate(code), c.dec)} ${c.sym}`;
      return `<button data-code="${code}" aria-label="${text} – ${c.name} verwenden">≈ ${text}</button>`;
    })
    .join('');

  const local = CURRENCIES[state.local];
  const manual = state.overrides[state.local] != null;
  $('rate-line').innerHTML = `1 € = ${formatRate(effectiveRate(state.local))} ${local.sym}` +
    (manual ? ' · <span class="manual">eigener Kurs</span>' : '');

  $('chips').innerHTML = CURRENCIES[inC].quick
    .map(q => `<button data-value="${q}">${format(q, 0)} ${CURRENCIES[inC].sym}</button>`)
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
    for (const src of SOURCES) {
      try {
        const rates = src.parse(await fetchJson(src.url));
        if (rates && FOREIGN.every(c => typeof rates[c] === 'number' && rates[c] > 0)) {
          for (const c of FOREIGN) state.rates[c] = rates[c];
          state.fetchedAt = Date.now();
          state.source = src.name;
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
  if (navigator.onLine && (!state.fetchedAt || Date.now() - state.fetchedAt > MAX_AGE_MS)) {
    refreshRates();
  }
}

// ---------- Einstellungen ----------

function renderSettings() {
  for (const b of $('dir-tabs').children) {
    b.setAttribute('aria-selected', String((b.dataset.inverse === '1') === state.inverse));
  }
  const list = $('settings-list');
  list.innerHTML = '';
  for (const code of FOREIGN) {
    const c = CURRENCIES[code];
    const manual = state.overrides[code] != null;
    const rate = effectiveRate(code);
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `
      <div class="set-top">
        <span class="badge" aria-hidden="true">${c.sym}</span>
        <span class="set-name"><b>${code}</b><small>${c.name}</small></span>
        <label class="switch"><span>Eigener Kurs</span><input type="checkbox" role="switch" ${manual ? 'checked' : ''}></label>
      </div>
      <label class="set-rate">
        <span>1 ${state.inverse ? c.sym : '€'} =</span>
        <input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" aria-label="Kurs für ${c.name}" ${manual ? '' : 'disabled'}>
        <span>${state.inverse ? '€' : c.sym}</span>
      </label>
      ${manual ? `<div class="set-foot"><span>Online: 1 € = ${formatRate(state.rates[code])} ${c.sym}</span><button type="button">Online-Kurs übernehmen</button></div>` : ''}`;

    const input = row.querySelector('.set-rate input');
    input.value = formatRate(state.inverse ? 1 / rate : rate);

    row.querySelector('.switch input').addEventListener('change', e => {
      if (e.target.checked) state.overrides[code] = state.rates[code];
      else delete state.overrides[code];
      save();
      renderSettings();
      if (e.target.checked) list.children[FOREIGN.indexOf(code)].querySelector('.set-rate input').focus();
    });
    input.addEventListener('change', () => {
      const n = parseNumber(input.value);
      if (n > 0) {
        state.overrides[code] = state.inverse ? 1 / n : n;
        save();
      }
      renderSettings();
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    const reset = row.querySelector('.set-foot button');
    if (reset) {
      reset.addEventListener('click', () => {
        state.overrides[code] = state.rates[code];
        save();
        renderSettings();
      });
    }
    list.appendChild(row);
  }
  renderStatus();
}

function showSettings(show) {
  $('view-settings').hidden = !show;
  $('view-calc').hidden = show;
  window.scrollTo(0, 0);
  if (show) renderSettings();
  else renderCalc();
}

// ---------- Start ----------

load();
renderCalc();

$('tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) selectCountry(b.dataset.country);
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
$('btn-settings').addEventListener('click', () => showSettings(true));
$('btn-back').addEventListener('click', () => showSettings(false));
$('dir-tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.inverse = b.dataset.inverse === '1';
  save();
  renderSettings();
});

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
  if (!$('view-settings').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
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
