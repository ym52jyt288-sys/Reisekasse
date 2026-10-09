'use strict';

// Kurse sind immer "1 EUR = x Währung". Kreuzkurse laufen über EUR.
const CURRENCIES = [
  { code: 'EUR', name: 'Euro',          flag: '🇪🇺', decimals: 2, quick: [5, 10, 20, 50, 100] },
  { code: 'THB', name: 'Thai Baht',     flag: '🇹🇭', decimals: 2, quick: [20, 100, 500, 1000] },
  { code: 'LAK', name: 'Laotischer Kip', flag: '🇱🇦', decimals: 0, quick: [10000, 20000, 50000, 100000] },
  { code: 'KHR', name: 'Kambod. Riel',  flag: '🇰🇭', decimals: 0, quick: [1000, 5000, 10000, 20000, 50000] },
  { code: 'USD', name: 'US-Dollar',     flag: '🇺🇸', decimals: 2, quick: [1, 5, 10, 20, 50] },
];
const FOREIGN = CURRENCIES.filter(c => c.code !== 'EUR').map(c => c.code);

// Notfall-Kurse für den allerersten Start ohne Internet (Stand 09.10.2026).
const DEFAULT_RATES = { THB: 37.71, LAK: 24928, KHR: 4543, USD: 1.1208 };

const STORAGE_KEY = 'fx-state-v1';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

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
  fetchedAt: null,     // ms timestamp der letzten erfolgreichen Online-Abfrage
  source: null,
  overrides: {},       // code -> manueller Kurs (1 EUR = x)
  active: 'EUR',
  amount: 10,
  inverse: false,      // Einstellungen: Eingabe als "1 X = … EUR"
};
let statusError = null;
let loading = false;

// ---------- Persistenz ----------

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch (e) { /* ohne Speicher weiter mit Defaults */ }
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignorieren */ }
}

// ---------- Rechnen & Formatieren ----------

function currency(code) { return CURRENCIES.find(c => c.code === code); }

function effectiveRate(code) {
  if (code === 'EUR') return 1;
  return state.overrides[code] ?? state.rates[code];
}

function convert(amount, from, to) {
  return amount / effectiveRate(from) * effectiveRate(to);
}

function format(value, decimals) {
  if (!isFinite(value)) return '';
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatRate(value) {
  const digits = value >= 100 ? 0 : value >= 10 ? 2 : value >= 1 ? 4 : 6;
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(value);
}

// Akzeptiert "1.234,5", "1234.5", "50.000" (bei Kip/Riel) usw.
function parseNumber(text, decimals = 2) {
  let s = String(text).replace(/[\s ']/g, '');
  if (!s) return 0;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (decimals === 0 || (s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isFinite(n) && n >= 0 ? n : NaN;
}

// ---------- Rechner-Ansicht ----------

const $ = id => document.getElementById(id);

function buildCalc() {
  const list = $('currency-list');
  list.innerHTML = '';
  for (const c of CURRENCIES) {
    const li = document.createElement('li');
    li.className = 'cur';
    li.dataset.code = c.code;
    li.innerHTML = `
      <div class="cur-meta">
        <span class="cur-code"><span class="flag">${c.flag}</span>${c.code}</span>
        <span class="cur-name">${c.name}</span>
        <span class="cur-badge" hidden>manuell</span>
      </div>
      <input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done"
             aria-label="Betrag in ${c.name}">`;
    const input = li.querySelector('input');
    input.addEventListener('focus', () => {
      if (state.active !== c.code) {
        state.amount = parseNumber(input.value, c.decimals) || 0;
        state.active = c.code;
        renderCalc();
      }
      input.select();
    });
    input.addEventListener('input', () => {
      const n = parseNumber(input.value, c.decimals);
      if (isNaN(n)) return;
      state.active = c.code;
      state.amount = n;
      renderCalc({ skipActive: true });
      save();
    });
    input.addEventListener('blur', () => renderCalc());
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    li.addEventListener('click', () => input.focus());
    list.appendChild(li);
  }
}

function renderCalc({ skipActive = false } = {}) {
  for (const li of document.querySelectorAll('.cur')) {
    const c = currency(li.dataset.code);
    const isActive = c.code === state.active;
    li.classList.toggle('active', isActive);
    li.querySelector('.cur-badge').hidden = state.overrides[c.code] == null;
    if (isActive && skipActive) continue;
    const value = convert(state.amount, state.active, c.code);
    li.querySelector('input').value = format(value, c.decimals);
  }

  const active = currency(state.active);
  $('quick-cur').textContent = `(${active.code})`;
  const quick = $('quick-buttons');
  quick.innerHTML = '';
  for (const v of active.quick) {
    const b = document.createElement('button');
    b.textContent = format(v, 0);
    b.addEventListener('click', () => {
      state.amount = v;
      renderCalc();
      save();
    });
    quick.appendChild(b);
  }
  renderStatus();
}

function renderStatus() {
  const el = $('status');
  const parts = [];
  if (state.fetchedAt) {
    const d = new Date(state.fetchedAt);
    const when = d.toLocaleDateString('de-DE') + ' ' +
      d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    parts.push(`Online-Kurse vom ${when}`);
  } else {
    parts.push('Eingebaute Standardkurse (Okt. 2026) – bitte aktualisieren');
  }
  if (!navigator.onLine) parts.push('offline');
  const manual = FOREIGN.filter(c => state.overrides[c] != null);
  if (manual.length) parts.push(`manuell: ${manual.join(', ')}`);
  if (state.active !== 'EUR') {
    parts.push(`1 EUR = ${formatRate(effectiveRate(state.active))} ${state.active}`);
  }
  el.textContent = statusError ? `${statusError} · ${parts.join(' · ')}` : parts.join(' · ');
  el.classList.toggle('error', !!statusError);
  const btn = $('btn-refresh');
  btn.disabled = loading;
  btn.textContent = loading ? 'Lade Kurse …' : 'Kurse aktualisieren';
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
    statusError = navigator.onLine ? 'Kurse konnten nicht geladen werden' : 'Keine Internetverbindung';
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
  $('chk-inverse').checked = state.inverse;
  const list = $('settings-list');
  list.innerHTML = '';
  for (const code of FOREIGN) {
    const c = currency(code);
    const manual = state.overrides[code] != null;
    const rate = effectiveRate(code);
    const shown = state.inverse ? 1 / rate : rate;
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `
      <div class="set-head">
        <span>${c.flag} ${c.code} · ${c.name}</span>
        <label><input type="checkbox" ${manual ? 'checked' : ''}> manuell</label>
      </div>
      <div class="set-input">
        <span>1 ${state.inverse ? code : 'EUR'} =</span>
        <input type="text" inputmode="decimal" ${manual ? '' : 'disabled'}>
        <span>${state.inverse ? 'EUR' : code}</span>
      </div>
      <div class="set-online">Online-Kurs: 1 EUR = ${formatRate(state.rates[code])} ${code}${
        manual ? '<button type="button">übernehmen</button>' : ''}</div>`;
    const input = row.querySelector('.set-input input');
    input.value = formatRate(shown);

    row.querySelector('.set-head input').addEventListener('change', e => {
      if (e.target.checked) state.overrides[code] = state.rates[code];
      else delete state.overrides[code];
      save();
      renderSettings();
      if (e.target.checked) {
        list.children[FOREIGN.indexOf(code)].querySelector('.set-input input').focus();
      }
    });
    input.addEventListener('change', () => {
      const n = parseNumber(input.value, 6);
      if (n > 0) {
        state.overrides[code] = state.inverse ? 1 / n : n;
        save();
      }
      renderSettings();
    });
    const reset = row.querySelector('.set-online button');
    if (reset) reset.addEventListener('click', () => {
      state.overrides[code] = state.rates[code];
      save();
      renderSettings();
    });
    list.appendChild(row);
  }
}

function showSettings(show) {
  $('view-settings').hidden = !show;
  $('view-calc').hidden = show;
  if (show) renderSettings();
  else renderCalc();
}

// ---------- Start ----------

load();
buildCalc();
renderCalc();

$('btn-refresh').addEventListener('click', refreshRates);
$('btn-settings').addEventListener('click', () => showSettings($('view-settings').hidden));
$('btn-back').addEventListener('click', () => showSettings(false));
$('chk-inverse').addEventListener('change', e => {
  state.inverse = e.target.checked;
  save();
  renderSettings();
});
window.addEventListener('online', () => { renderStatus(); maybeAutoRefresh(); });
window.addEventListener('offline', renderStatus);

maybeAutoRefresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
