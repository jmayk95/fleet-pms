/* ============================================================
   FLEETLINE · app.js (v23 — Job Order round-trip fixed)
   Pure orchestrator: router, modals, auth, Sheets client, prefs.
   ============================================================ */

const SHEETS_URL = "https://script.google.com/macros/s/AKfycbyLoOE2wkj2EwL_PmjGwecdM3chLeA2mqWE93QdbMzPC_4BgACoA1yikj0fqG-5kKFaYQ/exec";
const DEFAULT_ADMIN_EMAIL = 'jguardian@nrdev.ph';

const ACCESS_STORAGE_KEY = 'fleetline-access-accounts-v1';
const ACTIVITY_STORAGE_KEY = 'fleetline-activity-v1';
const USER_STORAGE_KEY = 'fleetline-user-v1';
const PREFS_STORAGE_KEY = 'fleetline-prefs-v1';
const SORT_KEY = 'fleetline-sort-v1';
const VEHICLES_CACHE_KEY = 'fleetline-vehicles-cache-v1';
const CHECKLIST_STATE_KEY = 'fleetline-checklist-state-v1';
const CHECKLIST_NOTES_KEY = 'fleetline-checklist-notes-v1';
const SESSION_TOKEN_KEY = 'fleetline-session-token-v1';
const CACHE_TTL_MS = 60 * 1000;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const PMS_NEAR_DUE_KM = 200;
const PMS_NEAR_DUE_DAYS = 15;
const VIN_LENGTH = 17;
const PLATE_LENGTH = 6;
const VIN_REGEX = /^[A-Z0-9]{17}$/;
const PLATE_REGEX = /^[A-Z0-9]{6}$/;

/* ============ JOB ORDER MARKERS ============ */
// Machine-only markers written to v.notes. Using angle-bracket tokens means
// a user typing "[Issue]" or "issue" into a remark can never be mistaken
// for a section boundary.
const JO_MARKERS = {
  issue:   '<<JO:ISSUE>>',
  parts:   '<<JO:PARTS>>',
  remarks: '<<JO:REMARKS>>',
  end:     '<<JO:END>>'
};

const today = new Date();
today.setHours(0, 0, 0, 0);

const SERVICE_SCHEDULE = [
  { milestone: '1st Service',  months: 1,  threshold: 1000  },
  { milestone: '2nd Service',  months: 3,  threshold: 5000  },
  { milestone: '3rd Service',  months: 6,  threshold: 10000 },
  { milestone: '4th Service',  months: 12, threshold: 15000 },
  { milestone: '5th Service',  months: 18, threshold: 20000 },
  { milestone: '6th Service',  months: 24, threshold: 25000 },
  { milestone: '7th Service',  months: 30, threshold: 30000 },
  { milestone: '8th Service',  months: 36, threshold: 35000 },
  { milestone: '9th Service',  months: 42, threshold: 40000 },
  { milestone: '10th Service', months: 48, threshold: 45000 },
  { milestone: '11th Service', months: 54, threshold: 50000 },
  { milestone: '12th Service', months: 60, threshold: 55000 }
];

const MAINTENANCE_CHECKLIST = [
  { item: 'Front & Rear Brakes',                  actions: { '1': 'I', '2': 'C', '3': 'C', '4': 'R', '5': 'I/R' } },
  { item: 'Tire Pressure',                        actions: { '1': 'I', '2': 'I', '3': 'I', '4': 'I', '5': 'I' } },
  { item: 'Tire wear & tear',                     actions: { '1': 'I', '2': 'I', '3': 'I', '4': 'I', '5': 'I/R' } },
  { item: 'All lights',                           actions: { '1': 'I', '2': 'I', '3': 'I' } },
  { item: 'Control Cables',                       actions: { '1': 'I' } },
  { item: 'Front & Rear Wheel bearing',           actions: { '1': 'L', '4': 'I/R' } },
  { item: 'Battery',                              actions: { '1': 'I', '2': 'C', '3': 'C', '4': 'C', '5': 'C' } },
  { item: 'Front Fork Play',                      actions: { '1': 'T', '4': 'I' } },
  { item: 'Nuts & bolts',                         actions: { '1': 'T', '2': 'T', '3': 'T' } },
  { item: 'Battery charger',                      actions: { '1': 'I' } },
  { item: 'Battery swapping',                     actions: { '1': 'I' } },
  { item: 'Front & Rear Suspension',              actions: { '1': 'I', '4': 'I' } },
  { item: 'Check for cut & burning wire harness', actions: { '1': 'I' } },
  { item: 'Change oil of side motor',             actions: { '2': 'R', '3': 'R', '4': 'R', '5': 'R' } },
  { item: 'Check movements of Throttle',          actions: { '1': 'I', '2': 'I' } },
  { item: 'Check all electrical switches',        actions: { '1': 'I', '2': 'I', '3': 'I' } },
  { item: 'Check speedometer function',           actions: { '1': 'I', '2': 'I', '3': 'I', '4': 'I' } }
];

const DEFAULT_PREFS = {
  density: 'cozy', dateFormat: 'long', defaultView: 'overview',
  clockFormat: '12h', showAlerts: true, showHelp: true, compactHeading: false, reduceMotion: false,
  serviceLogic: 'both'
};

let prefs = loadPrefs();
window.FleetlinePrefs = prefs;

let vehicles = [];
let filteredVehicles = [];
let accessAccounts = [];
let recentActivity = [];
let serviceLog = [];
let activeView = 'overview';
let toastTimer;
let currentUser = null;
let clockTimer = null;
let sortState = loadSortState();
let autoSaveTimer = null;
let activeAlertCategory = 'all';
let checklistState = new Map();
let checklistNotes = new Map();
let historyData = [];
let fleetLoadFailed = false;
let writeInFlight = false;

let partsCache = [];

async function loadPartsList() {
  try {
    const res = await sheetsGet('partsList');
    if (res.ok && res.parts) {
      partsCache = res.parts;
      const datalist = document.getElementById('parts-list');
      if (datalist) {
        datalist.innerHTML = partsCache.map(p => `<option value="${escapeHtml(p.itemCode)}">${escapeHtml(p.description)}</option>`).join('');
      }
    }
  } catch (err) {
    console.warn('Could not load parts list:', err);
  }
}

/* ============ SESSION TIMEOUT ============ */
let sessionTimer = null;
let sessionListeners = [];
let sessionTimeoutEnabled = false;
function resetSessionTimer() {
  if (!sessionTimeoutEnabled || !currentUser) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { handleSessionExpired(); }, SESSION_TIMEOUT_MS);
}
function startSessionTimer() {
  if (sessionTimeoutEnabled) return;
  sessionTimeoutEnabled = true;
  const events = ['click', 'keydown', 'scroll', 'touchstart'];
  const handler = () => resetSessionTimer();
  events.forEach(e => document.addEventListener(e, handler, { passive: true }));
  sessionListeners = events.map(e => ({ e, handler }));
  resetSessionTimer();
}
function stopSessionTimer() {
  sessionTimeoutEnabled = false;
  clearTimeout(sessionTimer);
  sessionTimer = null;
  sessionListeners.forEach(({ e, handler }) => document.removeEventListener(e, handler));
  sessionListeners = [];
}
function handleSessionExpired() {
  stopSessionTimer(); stopClock(); closeVehicleDrawer(); closeServiceHistoryDrawer();
  localStorage.removeItem(SESSION_TOKEN_KEY); saveUser(null);
  document.querySelector('#app-shell').classList.remove('visible');
  document.querySelector('#login-gate').classList.remove('hidden');
  document.querySelector('#login-form').reset();
  document.querySelector('#login-error-text').textContent = 'Session expired. Please sign in again.';
  document.querySelector('#login-error').classList.add('visible');
}

/* ============ TOP PROGRESS BAR ============ */
let progressEl = null;
let progressTimers = [];
function getProgressEl() {
  if (progressEl) return progressEl;
  progressEl = document.createElement('div');
  progressEl.className = 'top-progress';
  document.body.appendChild(progressEl);
  return progressEl;
}
function showProgress() {
  const el = getProgressEl();
  el.classList.remove('is-done'); el.classList.add('is-active');
  progressTimers.forEach(t => clearTimeout(t)); progressTimers = [];
}
function hideProgress() {
  const el = getProgressEl();
  el.classList.remove('is-active'); el.classList.add('is-done');
  progressTimers.forEach(t => clearTimeout(t));
  progressTimers = [setTimeout(() => el.classList.remove('is-done'), 400)];
}

/* ============ HELPERS ============ */
function safeNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
}
function normalizeVin(v) { return String(v ?? '').trim().toUpperCase(); }
function normalizePlate(v) { return String(v ?? '').trim().toUpperCase(); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function formatNumber(n) { if (n === '' || n === null || n === undefined) return '—'; return safeNum(n).toLocaleString('en-US'); }
function dateInputValue(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function addMonthsToDate(dateString, months) {
  if (!dateString) return '';
  const m = String(dateString).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const [, y, mo, d] = m;
  const targetMonth = new Date(Number(y), Number(mo) - 1 + months, 1);
  const targetDay = Math.min(Number(d), new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate());
  return dateInputValue(new Date(targetMonth.getFullYear(), targetMonth.getMonth(), targetDay));
}
function getServicePlan(saleDate, lastService) {
  const idx = SERVICE_SCHEDULE.findIndex(s => s.milestone === lastService);
  const next = SERVICE_SCHEDULE[idx + 1];
  return { nextMilestone: next?.milestone || 'All Complete', threshold: next?.threshold || 0, dueDate: next ? addMonthsToDate(saleDate, next.months) : '' };
}
function formatDate(value) {
  if (!value) return 'Not set';
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(value);
  const [, y, mo, d] = m;
  const dateObj = new Date(Number(y), Number(mo) - 1, Number(d));
  if (isNaN(dateObj.getTime())) return String(value);
  if (prefs.dateFormat === 'short') return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(dateObj);
  if (prefs.dateFormat === 'numeric') return `${y}-${mo}-${d}`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(dateObj);
}
function formatShortDate(value) { return formatDate(value); }
function formatDateTime(isoString) {
  if (!isoString) return '—';
  const dt = new Date(isoString);
  if (isNaN(dt.getTime())) return String(isoString);
  const datePart = prefs.dateFormat === 'short'
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(dt)
    : prefs.dateFormat === 'numeric'
      ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
      : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(dt);
  const timeOpts = prefs.clockFormat === '24h'
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { hour: '2-digit', minute: '2-digit', hour12: true };
  return `${datePart} · ${new Intl.DateTimeFormat('en-US', timeOpts).format(dt)}`;
}
  /* ---------- Vehicle image ---------- */
function getVehicleImage(model, color, isProfile = false) {
  if (!model || !color) return null;
  const modelAliases = {
    'R280 Sport': 'R280',
    // Add future models here, e.g.:
    // 'R500 Pro': 'R500'
  };
  const imageModel = modelAliases[model] || model;
  const m = String(imageModel).toLowerCase().trim().replace(/\s+/g, '-');
  const c = String(color).toLowerCase().trim().replace(/\s+/g, '-');
  return `images/${m}-${c}${isProfile ? '-profile' : ''}.png`;
}
function daysUntil(dateString) {
  if (!dateString) return 0;
  const m = String(dateString).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  const [, y, mo, d] = m;
  const dateObj = new Date(Number(y), Number(mo) - 1, Number(d));
  if (isNaN(dateObj.getTime())) return 0;
  return Math.round((dateObj - today) / 86400000);
}
function isComplete(v) { return v.nextMilestone === 'All Complete' || safeNum(v.threshold) === 0; }
function isOverdue(v) {
  if (isComplete(v)) return false;
  const days = daysUntil(v.dueDate);
  const km = safeNum(v.threshold) - safeNum(v.odometer);
  if (prefs.serviceLogic === 'days') return days < 0;
  if (prefs.serviceLogic === 'km') return km < 0;
  return days < 0 || km < 0;
}
function isDueSoon(v) {
  if (isComplete(v) || isOverdue(v)) return false;
  const days = daysUntil(v.dueDate);
  const km = safeNum(v.threshold) - safeNum(v.odometer);
  if (prefs.serviceLogic === 'days') return days >= 0 && days <= PMS_NEAR_DUE_DAYS;
  if (prefs.serviceLogic === 'km') return km >= 0 && km <= PMS_NEAR_DUE_KM;
  return (days >= 0 && days <= PMS_NEAR_DUE_DAYS) || (km >= 0 && km <= PMS_NEAR_DUE_KM);
}
function vehiclePmStatus(v) {
  if (isComplete(v)) return 'Complete';
  if (isOverdue(v)) return 'Overdue';
  if (isDueSoon(v)) return 'Due Soon';
  return 'On Track';
}
function getServiceBucket(v) {
  if (isComplete(v)) return 'complete';
  if (isOverdue(v)) return 'overdue';
  if (daysUntil(v.dueDate) >= 0 && daysUntil(v.dueDate) <= 15) return 'due-soon';
  return 'on-track';
}

/* ============ FETCH ============ */
const FETCH_TIMEOUT_MS = 15000;
const FETCH_RETRY_DELAY_MS = 800;
async function fetchWithRetry(url, options = {}, { retries = 1, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer); lastErr = err;
      if ((err.name !== 'AbortError' && err.name !== 'TypeError') || attempt === retries) break;
      await new Promise(r => setTimeout(r, FETCH_RETRY_DELAY_MS));
    }
  }
  throw lastErr || new Error('Request failed');
}

/* ============ SHEETS API ============ */
async function sheetsGet(action, params = {}) {
  // --- GUARD: catch null/undefined action before it becomes "/null" ---
  if (action === null || action === undefined || action === '' || action === 'null' || action === 'undefined') {
    console.error('[sheetsGet] called with invalid action:', action, '\nStack:', new Error().stack);
    throw new Error(`sheetsGet: invalid action "${action}"`);
  }

  const token = localStorage.getItem(SESSION_TOKEN_KEY) || '';
  // Build query params cleanly. If a caller passed a legacy string like
  // "holidays&year=2026", split it off so older call sites keep working.
  let baseAction = String(action);
  let extraParams = '';
  const ampIdx = baseAction.indexOf('&');
  if (ampIdx !== -1) {
    extraParams = '&' + baseAction.slice(ampIdx + 1);
    baseAction = baseAction.slice(0, ampIdx);
  }
  const qs = new URLSearchParams({ action: baseAction, sessionToken: token });
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) qs.set(k, String(v)); });
  const url = `${SHEETS_URL}?${qs.toString()}${extraParams}`;
  showProgress();
  try {
    const res = await fetchWithRetry(url, { method: 'GET' });
    if (!res.ok) throw new Error(`GET ${baseAction} failed: ${res.status}`);
    const json = await res.json();
    if (!json.ok) {
      if (json.code === 'SESSION_EXPIRED') handleSessionExpired();
      throw new Error(json.error || 'Unknown API error');
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Check your connection and try again.');
    throw err;
  } finally { hideProgress(); }
}
async function sheetsPost(action, payload) {
  // --- GUARD: catch null/undefined action ---
  if (action === null || action === undefined || action === '' || action === 'null' || action === 'undefined') {
    console.error('[sheetsPost] called with invalid action:', action, '\nStack:', new Error().stack);
    throw new Error(`sheetsPost: invalid action "${action}"`);
  }

  const token = localStorage.getItem(SESSION_TOKEN_KEY) || '';
  showProgress();
  try {
    const res = await fetchWithRetry(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, sessionToken: token, ...payload })
    });
    if (!res.ok) throw new Error(`POST ${action} failed: ${res.status}`);
    const json = await res.json();
    if (!json.ok) {
      if (json.code === 'SESSION_EXPIRED') handleSessionExpired();
      throw new Error(json.error || 'Unknown API error');
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Check your connection and try again.');
    throw err;
  } finally { hideProgress(); }
}
let refreshDebounceTimer = null;
async function sheetsMutate(action, payload) {
  if (action === null || action === undefined || action === '' || action === 'null' || action === 'undefined') {
    console.error('[sheetsMutate] called with invalid action:', action, '\nStack:', new Error().stack);
    throw new Error(`sheetsMutate: invalid action "${action}"`);
  }
  writeInFlight = true;
  try { return await sheetsPost(action, payload); }
  finally {
    writeInFlight = false;
    clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => { if (!writeInFlight) refreshVehiclesInBackground(); }, 300);
  }
}

/* ============ CACHE ============ */
function readCache() {
  try {
    const raw = localStorage.getItem(VEHICLES_CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !Array.isArray(p.data) || typeof p.timestamp !== 'number') return null;
    if (Date.now() - p.timestamp > CACHE_TTL_MS) return null;
    return p.data;
  } catch { return null; }
}
function writeCache(data) { try { localStorage.setItem(VEHICLES_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data })); } catch {} }
function invalidateCache() { try { localStorage.removeItem(VEHICLES_CACHE_KEY); } catch {} }

async function loadVehiclesFromSheets(opts = {}) {
  const { force = false } = opts;
  if (!force) {
    const cached = readCache();
    if (cached) { fleetLoadFailed = false; applyFleetErrorState(); refreshVehiclesInBackground(); return cached.map(normalizeVehicle); }
  }
  try {
    const { vehicles: rows } = await sheetsGet('vehicles');
    writeCache(rows); fleetLoadFailed = false; applyFleetErrorState();
    return rows.map(normalizeVehicle);
  } catch (err) {
    console.error('[Fleetline] Failed to load vehicles:', err);
    fleetLoadFailed = true; applyFleetErrorState(err.message || 'Could not reach the server.');
    return [];
  }
}
function refreshVehiclesInBackground() {
  if (writeInFlight) return;
  if (anyDialogOpen()) return;
  sheetsGet('vehicles').then(({ vehicles: rows }) => {
    if (writeInFlight || anyDialogOpen()) return;
    writeCache(rows); vehicles = rows.map(normalizeVehicle);
    fleetLoadFailed = false; applyFleetErrorState(); render();
  }).catch(err => console.warn('[Fleetline] Background refresh failed:', err));
}
function anyDialogOpen() {
  return Array.from(document.querySelectorAll('dialog')).some(d => d.open);
}
function applyFleetErrorState(message) {
  const banner = document.querySelector('#data-error');
  const msgEl = document.querySelector('#data-error-message');
  if (banner) banner.hidden = !fleetLoadFailed;
  if (msgEl && message) msgEl.textContent = message;
  document.body.dataset.fleetError = String(!!fleetLoadFailed);
}
async function retryFleetLoad() {
  const retryBtn = document.querySelector('#data-error-retry');
  if (retryBtn) { retryBtn.disabled = true; retryBtn.innerHTML = '<i data-lucide="loader-2"></i> Retrying…'; }
  if (window.lucide) window.lucide.createIcons();
  try {
    invalidateCache();
    vehicles = await loadVehiclesFromSheets({ force: true });
    await loadHistory(); await loadServiceLog();
    render();
    if (!fleetLoadFailed) showToast('Fleet loaded');
  } catch (err) { console.error('[Fleetline] Retry failed:', err); }
  finally {
    if (retryBtn) { retryBtn.disabled = false; retryBtn.innerHTML = '<i data-lucide="rotate-cw"></i> Retry'; if (window.lucide) window.lucide.createIcons(); }
  }
}

/* ============ HISTORY / SERVICE LOG ============ */
async function loadHistory() {
  try { const { history } = await sheetsGet('history'); historyData = Array.isArray(history) ? history : []; }
  catch (err) { console.warn('[Fleetline] Could not load history:', err); historyData = []; }
}
async function loadServiceLog() {
  try { const { entries } = await sheetsGet('serviceLog'); serviceLog = Array.isArray(entries) ? entries : []; }
  catch (err) { console.warn('[Fleetline] Could not load service log:', err); serviceLog = []; }
}
function getServiceLogForVehicle(vehicleIdOrVin, vin, plate) {
  const ids = new Set();
  if (vehicleIdOrVin) ids.add(String(vehicleIdOrVin).trim());
  if (vin) ids.add(String(vin).trim().toUpperCase());
  if (plate) ids.add(String(plate).trim().toUpperCase());
  if (ids.size === 0) return [];
  return serviceLog.filter(e => {
    const eId = String(e.vehicleId || '').trim();
    const eVin = String(e.vin || '').trim().toUpperCase();
    const ePlate = String(e.plate || '').trim().toUpperCase();
    return ids.has(eId) || ids.has(eVin) || ids.has(ePlate);
  }).sort((a, b) => (new Date(b.completedAt).getTime() || 0) - (new Date(a.completedAt).getTime() || 0));
}
async function appendServiceLogEntry(entry) {
  try { const res = await sheetsMutate('addServiceLog', { entry }); loadServiceLog(); return res; }
  catch (err) { console.error('[Fleetline] Could not write service log:', err); throw err; }
}

/* ============ PREFS ============ */
function loadPrefs() { try { const s = JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY)); return { ...DEFAULT_PREFS, ...(s || {}) }; } catch { return { ...DEFAULT_PREFS }; } }
function savePrefs() { localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs)); window.FleetlinePrefs = prefs; }
function applyPrefs() {
  document.documentElement.dataset.density = prefs.density;
  document.documentElement.dataset.compactHeading = String(prefs.compactHeading);
  document.documentElement.dataset.hideHelp = String(!prefs.showHelp);
  document.documentElement.dataset.noAnim = String(prefs.reduceMotion);
  const alertsBtn = document.querySelector('#notification-button');
  if (alertsBtn) alertsBtn.style.display = prefs.showAlerts ? '' : 'none';
  const clockEl = document.querySelector('#live-clock');
  if (clockEl) clockEl.hidden = prefs.clockFormat === 'hidden';
  syncSettingsControls(); syncDensitySwitch();
  if (window.lucide) window.lucide.createIcons();
  renderDate(); updateClock();
}
function syncSettingsControls() {
  const map = { 'set-density': prefs.density, 'set-date-format': prefs.dateFormat, 'set-default-view': prefs.defaultView, 'set-clock-format': prefs.clockFormat, 'set-service-logic': prefs.serviceLogic };
  for (const [id, val] of Object.entries(map)) { const el = document.getElementById(id); if (el) el.value = val; }
  const bools = { 'set-show-alerts': prefs.showAlerts, 'set-show-help': prefs.showHelp, 'set-compact-heading': prefs.compactHeading, 'set-reduce-motion': prefs.reduceMotion };
  for (const [id, val] of Object.entries(bools)) { const el = document.getElementById(id); if (el) el.checked = val; }
}
function syncDensitySwitch() {
  document.querySelectorAll('.density-switch button').forEach(b => b.classList.toggle('active', b.dataset.density === prefs.density));
}
function flashAutoSave(label = 'Saved') {
  let flash = document.querySelector('.auto-save-flash');
  if (!flash) {
    flash = document.createElement('div');
    flash.className = 'auto-save-flash';
    flash.innerHTML = '<i data-lucide="check-circle-2"></i><span></span>';
    document.body.appendChild(flash);
    if (window.lucide) window.lucide.createIcons();
  }
  flash.querySelector('span').textContent = label;
  flash.classList.add('visible');
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => flash.classList.remove('visible'), 1400);
}
function loadSortState() { try { const s = JSON.parse(localStorage.getItem(SORT_KEY)); return s && s.key !== undefined ? s : { key: null, dir: 'asc' }; } catch { return { key: null, dir: 'asc' }; } }
function saveSortState() { localStorage.setItem(SORT_KEY, JSON.stringify(sortState)); }

/* ============ VEHICLE HELPERS ============ */
function normalizeVehicle(v) {
  return {
    ...v,
    vin: normalizeVin(v.vin),
    plate: normalizePlate(v.plate),
    ...getServicePlan(v.saleDate, v.lastService),
    workStatus: v.workStatus || 'Not Scheduled',
    scheduledDate: v.scheduledDate || '',
    actualOdo: v.actualOdo ?? '',
    notes: v.notes || ''
  };
}

/* ============ CHECKLIST ============ */
function getChecklistKey(milestone) {
  const idx = SERVICE_SCHEDULE.findIndex(s => s.milestone === milestone);
  if (idx === -1) return null;
  if (idx >= 4) return '5';
  return String(idx + 1);
}
function getChecklistForMilestone(milestone) {
  const key = getChecklistKey(milestone);
  if (!key) return [];
  return MAINTENANCE_CHECKLIST.filter(t => t.actions[key]).map(t => ({ item: t.item, action: t.actions[key] }));
}
function getChecklistContext(milestone) {
  const key = getChecklistKey(milestone);
  if (!key) return '—';
  const map = { '1': '1st month / 1,000 km', '2': '3rd month / 5,000 km', '3': '6th month / 10,000 km', '4': '12th month / 15,000 km', '5': 'Every 6th month / 5,000 km' };
  return map[key] || '—';
}
function getActionMeta(code) {
  const meta = {
    'I':   { label: 'Inspect',  icon: 'search' },
    'C':   { label: 'Clean',    icon: 'sparkles' },
    'R':   { label: 'Replace',  icon: 'replace' },
    'A':   { label: 'Adjust',   icon: 'settings-2' },
    'L':   { label: 'Lubricate', icon: 'droplet' },
    'T':   { label: 'Tighten',  icon: 'wrench' },
    'CC':  { label: 'Check Charge & Connections', icon: 'zap' },
    'I/R': { label: 'Inspect & Replace if Needed', icon: 'search-check' }
  };
  return meta[code] || { label: code, icon: 'circle-help' };
}
function getChecklistStorageKey(vehicleId, milestone) { return `${vehicleId}::${milestone}`; }
function persistChecklistState() {
  try {
    const s = {};
    checklistState.forEach((set, key) => { s[key] = Array.from(set); });
    localStorage.setItem(CHECKLIST_STATE_KEY, JSON.stringify(s));
  } catch (err) { console.warn(err); }
}
function persistChecklistNotes() {
  try {
    const s = {};
    checklistNotes.forEach((map, key) => {
      const obj = {};
      map.forEach((note, task) => { obj[task] = note; });
      s[key] = obj;
    });
    localStorage.setItem(CHECKLIST_NOTES_KEY, JSON.stringify(s));
  } catch (err) { console.warn(err); }
}
function restoreChecklistState() {
  try {
    const raw = localStorage.getItem(CHECKLIST_STATE_KEY);
    if (raw) { const p = JSON.parse(raw); Object.entries(p).forEach(([k, arr]) => { if (Array.isArray(arr)) checklistState.set(k, new Set(arr)); }); }
    const rawNotes = localStorage.getItem(CHECKLIST_NOTES_KEY);
    if (rawNotes) { const p = JSON.parse(rawNotes); Object.entries(p).forEach(([k, obj]) => { const m = new Map(); Object.entries(obj || {}).forEach(([t, n]) => m.set(t, n)); checklistNotes.set(k, m); }); }
  } catch (err) { console.warn(err); }
}
function getNotesStorageKey(vehicleId, milestone) { return `${vehicleId}::${milestone}`; }
function getTaskNote(vehicleId, milestone, taskName) {
  const k = getNotesStorageKey(vehicleId, milestone);
  const m = checklistNotes.get(k);
  return m ? (m.get(taskName) || '') : '';
}
function setTaskNote(vehicleId, milestone, taskName, note) {
  const k = getNotesStorageKey(vehicleId, milestone);
  if (!checklistNotes.has(k)) checklistNotes.set(k, new Map());
  const m = checklistNotes.get(k);
  const trimmed = String(note || '').trim();
  if (trimmed) m.set(taskName, trimmed); else m.delete(taskName);
}
function clearNotesForVehicle(vehicle) { checklistNotes.delete(getNotesStorageKey(vehicle.id, vehicle.nextMilestone)); }
function getNotesForVehicle(vehicle) {
  const k = getNotesStorageKey(vehicle.id, vehicle.nextMilestone);
  const m = checklistNotes.get(k);
  if (!m) return {};
  const out = {};
  m.forEach((n, t) => { if (n) out[t] = n; });
  return out;
}
function renderChecklistDialog(vehicle) {
  const dialog = document.querySelector('#checklist-dialog');
  const listEl = document.querySelector('#checklist-dialog-tasks');
  if (!dialog || !listEl) return;
  const milestone = vehicle.nextMilestone;
  const tasks = getChecklistForMilestone(milestone);
  if (tasks.length === 0) return;
  document.querySelector('#checklist-dialog-title').textContent = milestone;
  document.querySelector('#checklist-dialog-subtitle').textContent = getChecklistContext(milestone);
  const storageKey = getChecklistStorageKey(vehicle.id, milestone);
  if (!checklistState.has(storageKey)) checklistState.set(storageKey, new Set());
  const checkedSet = checklistState.get(storageKey);
  listEl.innerHTML = tasks.map(t => {
    const checked = checkedSet.has(t.item);
    const meta = getActionMeta(t.action);
    const note = getTaskNote(vehicle.id, milestone, t.item);
    const hasNote = note.length > 0;
    let cls = 'action-inspect';
    if (meta.label.includes('Replace')) cls = 'action-replace';
    else if (meta.label.includes('Clean')) cls = 'action-clean';
    else if (meta.label.includes('Tighten')) cls = 'action-tighten';
    else if (meta.label.includes('Lubricate')) cls = 'action-lubricate';
    return `<li class="checklist-task ${checked ? 'is-checked' : ''}" data-task="${escapeHtml(t.item)}">
      <div class="checklist-task-row">
        <label class="checklist-task-main">
          <input type="checkbox" data-task-item="${escapeHtml(t.item)}" ${checked ? 'checked' : ''} />
          <span class="checklist-task-name">${escapeHtml(t.item)}</span>
        </label>
        <span class="checklist-task-action ${cls}"><i data-lucide="${meta.icon}"></i> ${escapeHtml(meta.label)}</span>
        <button class="checklist-note-btn ${hasNote ? 'has-note' : ''}" type="button" data-note-toggle="${escapeHtml(t.item)}" title="${hasNote ? 'Edit note' : 'Add note'}"><i data-lucide="${hasNote ? 'message-square-text' : 'message-square-plus'}"></i></button>
      </div>
      <div class="checklist-note-wrap" data-note-wrap="${escapeHtml(t.item)}" ${hasNote ? '' : 'hidden'}>
        <textarea class="checklist-note-input" data-note-input="${escapeHtml(t.item)}" rows="2" placeholder="Add a note for this task…">${escapeHtml(note)}</textarea>
      </div>
    </li>`;
  }).join('');
  if (window.lucide) window.lucide.createIcons();
  listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.addEventListener('change', e => {
    const item = e.target.dataset.taskItem;
    if (e.target.checked) checkedSet.add(item); else checkedSet.delete(item);
    e.target.closest('.checklist-task').classList.toggle('is-checked', e.target.checked);
    persistChecklistState(); updateChecklistButtonLabel(vehicle); updateChecklistProgress(vehicle);
  }));
  listEl.querySelectorAll('[data-note-toggle]').forEach(btn => btn.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    const taskName = btn.dataset.noteToggle;
    const wrap = listEl.querySelector(`[data-note-wrap="${CSS.escape(taskName)}"]`);
    if (!wrap) return;
    wrap.hidden = !wrap.hidden;
    if (!wrap.hidden) { const i = wrap.querySelector('.checklist-note-input'); if (i) i.focus(); }
  }));
  listEl.querySelectorAll('[data-note-input]').forEach(input => input.addEventListener('input', e => {
    const taskName = e.target.dataset.noteInput;
    setTaskNote(vehicle.id, milestone, taskName, e.target.value);
    persistChecklistNotes();
    const btn = listEl.querySelector(`[data-note-toggle="${CSS.escape(taskName)}"]`);
    if (btn) { const hasNote = e.target.value.trim().length > 0; btn.classList.toggle('has-note', hasNote); }
  }));
  updateChecklistProgress(vehicle);
}
function updateChecklistButtonLabel(vehicle) {
  const labelEl = document.querySelector('#service-checklist-toggle-label');
  if (!labelEl) return;
  const tasks = getChecklistForMilestone(vehicle.nextMilestone);
  if (tasks.length === 0) { labelEl.textContent = 'Checklist'; return; }
  const storageKey = getChecklistStorageKey(vehicle.id, vehicle.nextMilestone);
  const checkedSet = checklistState.get(storageKey) || new Set();
  const done = checkedSet.size;
  labelEl.textContent = done === 0 ? `${tasks.length} tasks` : `${tasks.length} tasks (${done} of ${tasks.length} done)`;
  updateChecklistProgress(vehicle);
}
function updateChecklistProgress(vehicle) {
  const bar = document.querySelector('#checklist-dialog-progress-bar');
  const text = document.querySelector('#checklist-dialog-progress-text');
  if (!bar || !text) return;
  const tasks = getChecklistForMilestone(vehicle.nextMilestone);
  if (tasks.length === 0) { bar.style.width = '0%'; text.textContent = '0%'; return; }
  const storageKey = getChecklistStorageKey(vehicle.id, vehicle.nextMilestone);
  const checkedSet = checklistState.get(storageKey) || new Set();
  const done = checkedSet.size;
  const pct = Math.round((done / tasks.length) * 100);
  bar.style.width = `${pct}%`;
  const notesMap = checklistNotes.get(storageKey);
  const notesCount = notesMap ? notesMap.size : 0;
  const notesSuffix = notesCount > 0 ? ` · ${notesCount} ${notesCount === 1 ? 'note' : 'notes'}` : '';
  text.textContent = `${done}/${tasks.length} (${pct}%)${notesSuffix}`;
}
function openChecklistDialog(vehicle) {
  const dialog = document.querySelector('#checklist-dialog');
  if (!dialog || !vehicle) return;
  renderChecklistDialog(vehicle);
  dialog.showModal();
  if (window.lucide) window.lucide.createIcons();
}
function closeChecklistDialog() {
  const dialog = document.querySelector('#checklist-dialog');
  if (dialog && dialog.open) dialog.close();
}
function getCheckedTasksForVehicle(vehicle) {
  const k = getChecklistStorageKey(vehicle.id, vehicle.nextMilestone);
  const s = checklistState.get(k);
  return s ? Array.from(s) : [];
}
function clearCheckedTasksForVehicle(vehicle) { checklistState.delete(getChecklistStorageKey(vehicle.id, vehicle.nextMilestone)); }
function initChecklistControls() {
  const toggleBtn = document.querySelector('#service-checklist-toggle');
  const checkAllBtn = document.querySelector('#checklist-dialog-check-all');
  const uncheckAllBtn = document.querySelector('#checklist-dialog-uncheck-all');
  const closeBtn = document.querySelector('#checklist-dialog-close');
  const closeX = document.querySelector('.checklist-close');
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    const v = vehicles.find(x => x.id === activeServiceVehicleId);
    if (v) openChecklistDialog(v);
  });
  if (checkAllBtn) checkAllBtn.addEventListener('click', () => {
    const v = vehicles.find(x => x.id === activeServiceVehicleId);
    if (!v) return;
    const tasks = getChecklistForMilestone(v.nextMilestone);
    if (tasks.length === 0) return;
    checklistState.set(getChecklistStorageKey(v.id, v.nextMilestone), new Set(tasks.map(t => t.item)));
    persistChecklistState(); renderChecklistDialog(v); updateChecklistButtonLabel(v);
    showToast(`All ${tasks.length} tasks checked`);
  });
  if (uncheckAllBtn) uncheckAllBtn.addEventListener('click', () => {
    const v = vehicles.find(x => x.id === activeServiceVehicleId);
    if (!v) return;
    const tasks = getChecklistForMilestone(v.nextMilestone);
    if (tasks.length === 0) return;
    const k = getChecklistStorageKey(v.id, v.nextMilestone);
    if ((checklistState.get(k) || new Set()).size === 0) { showToast('No checked tasks to clear'); return; }
    checklistState.set(k, new Set());
    persistChecklistState(); renderChecklistDialog(v); updateChecklistButtonLabel(v);
    showToast('All tasks unchecked');
  });
  if (closeBtn) closeBtn.addEventListener('click', closeChecklistDialog);
  if (closeX) closeX.addEventListener('click', closeChecklistDialog);
}

/* ============ VALIDATION ============ */
function validateVehicleData(data, editingId = null) {
  const errors = {};
  const vin = normalizeVin(data.vin);
  const plate = normalizePlate(data.plate);
  if (!vin) errors.vin = 'VIN is required.';
  else if (vin.length !== VIN_LENGTH) errors.vin = `VIN must be exactly ${VIN_LENGTH} letters and numbers.`;
  else if (!VIN_REGEX.test(vin)) errors.vin = 'VIN can only contain letters and numbers.';
  else {
    const conflict = vehicles.find(v => v.id !== editingId && normalizeVin(v.vin) === vin);
    if (conflict) errors.vin = `This VIN is already used by another vehicle${conflict.plate ? ` (${conflict.plate})` : ''}.`;
  }
  if (plate) {
    if (plate.length !== PLATE_LENGTH) errors.plate = `Plate must be exactly ${PLATE_LENGTH} letters and numbers.`;
    else if (!PLATE_REGEX.test(plate)) errors.plate = 'Plate can only contain letters and numbers.';
    else {
      const conflict = vehicles.find(v => v.id !== editingId && v.plate && normalizePlate(v.plate) === plate);
      if (conflict) errors.plate = `This plate is already used by another vehicle${conflict.plate ? ` (${conflict.plate})` : ''}.`;
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/* ============ ACCESS / ACTIVITY ============ */
function loadAccessAccounts() { try { const s = JSON.parse(localStorage.getItem(ACCESS_STORAGE_KEY)); return Array.isArray(s) ? s : []; } catch { return []; } }
function persistAccessAccounts() { localStorage.setItem(ACCESS_STORAGE_KEY, JSON.stringify(accessAccounts)); }
function isAdmin() { return currentUser?.role === 'Admin'; }
async function refreshAccessAccountsFromSheets() {
  try {
    const { users } = await sheetsGet('users');
    accessAccounts = (users || []).map(u => ({ email: u.email, role: u.role, isPrimary: String(u.isPrimary).toUpperCase() === 'TRUE', addedAt: u.addedAt }));
    persistAccessAccounts(); renderAccessAccounts();
  } catch (err) { console.warn(err); }
}
function loadRecentActivity() { try { const s = JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY)); return Array.isArray(s) ? s : []; } catch { return []; } }
function recordActivity(message, category = 'Vehicles') {
  recentActivity.unshift({ message, category, actor: currentUser?.name || currentUser?.email || 'System', timestamp: new Date().toISOString() });
  recentActivity = recentActivity.slice(0, 12);
  localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(recentActivity));
  renderActivityFeed();
}
function renderActivityFeed() {
  const list = document.querySelector('#activity-drawer-list');
  if (!list) return;
  list.innerHTML = recentActivity.map(entry => {
    const actor = entry.actor || 'System';
    const elapsed = Math.max(0, Math.floor((Date.now() - new Date(entry.timestamp).getTime()) / 60000));
    let ago = 'Just now';
    if (elapsed >= 1 && elapsed < 60) ago = `${elapsed}m ago`;
    else if (elapsed >= 60 && elapsed < 1440) ago = `${Math.floor(elapsed / 60)}h ago`;
    else if (elapsed >= 1440) ago = `${Math.floor(elapsed / 1440)}d ago`;
    let iconClass = 'activity-icon-primary';
    let iconName = 'info';
    if (entry.category === 'Authentication') { iconClass = 'activity-icon-auth'; iconName = 'log-in'; }
    else if (entry.category === 'Vehicles') { iconClass = 'activity-icon-vehicles'; iconName = 'truck'; }
    else if (entry.category === 'Service schedule') { iconClass = 'activity-icon-service'; iconName = 'wrench'; }
    else if (entry.category === 'User access') { iconClass = 'activity-icon-access'; iconName = 'user-round'; }
    let msg = entry.message;
    if (msg.includes(actor)) msg = msg.replace(actor, '').trim();
    return `<li class="activity-entry">
      <span class="activity-avatar ${iconClass}"><i data-lucide="${iconName}"></i></span>
      <div class="activity-copy">
        <div class="activity-event"><strong>${escapeHtml(actor)}</strong> ${escapeHtml(msg)}</div>
        <div class="activity-meta">
          <span class="activity-tag">${escapeHtml(entry.category || 'Fleet update')}</span>
          <time datetime="${escapeHtml(entry.timestamp)}">${ago}</time>
        </div>
      </div>
    </li>`;
  }).join('');
  const empty = document.querySelector('#activity-drawer-empty');
  if (empty) empty.hidden = recentActivity.length > 0;
  if (window.lucide) window.lucide.createIcons();
}
function showToast(message, variant = 'success') {
  const region = document.querySelector('#toast-region');
  const toast = document.createElement('div');
  toast.className = 'toast-message';
  const iconName = variant === 'error' ? 'circle-x' : 'circle-check';
  toast.innerHTML = `<i data-lucide="${iconName}"></i><span></span>`;
  toast.querySelector('span').textContent = message;
  toast.classList.toggle('is-error', variant === 'error');
  region.replaceChildren(toast);
  region.classList.add('is-visible');
  if (window.lucide) window.lucide.createIcons();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => region.classList.remove('is-visible'), 4200);
}
function showErrorToast(message) { showToast(message, 'error'); }

/* ============ CONFIRM ============ */
function showConfirm(opts = {}) {
  return new Promise((resolve) => {
    const dialog = document.querySelector('#confirm-dialog');
    if (!dialog) { resolve(window.confirm(opts.title || 'Confirm?')); return; }
    const iconEl = document.querySelector('#confirm-icon');
    const variant = opts.variant || 'info';
    const iconMap = { success: 'check-circle-2', warning: 'triangle-alert', danger: 'trash-2', info: 'circle-help' };
    iconEl.className = 'confirm-dialog-icon';
    if (variant !== 'info') iconEl.classList.add(`variant-${variant}`);
    iconEl.innerHTML = `<i data-lucide="${iconMap[variant] || 'circle-help'}"></i>`;
    document.querySelector('#confirm-title').textContent = opts.title || 'Confirm';
    const desc = document.querySelector('#confirm-desc');
    desc.textContent = opts.description || '';
    desc.hidden = !opts.description;
    const detailEl = document.querySelector('#confirm-detail');
    if (opts.detail) { detailEl.innerHTML = opts.detail; detailEl.hidden = false; }
    else { detailEl.innerHTML = ''; detailEl.hidden = true; }
    const okBtn = document.querySelector('#confirm-ok');
    const cancelBtn = document.querySelector('#confirm-cancel');
    okBtn.textContent = opts.confirmLabel || 'Confirm';
    okBtn.className = 'button ' + (variant === 'danger' ? 'button-danger' : variant === 'success' ? 'button-success' : 'button-primary');
    cancelBtn.textContent = opts.cancelLabel || 'Cancel';
    if (window.lucide) window.lucide.createIcons();
    let resolved = false;
    function finish(r) {
      if (resolved) return;
      resolved = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      dialog.close();
      resolve(r);
    }
    function onOk() { finish(true); }
    function onCancel() { finish(false); }
    function onClose() { finish(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    requestAnimationFrame(() => cancelBtn.focus());
  });
}
function withButtonSpinner(button, label = 'Saving…') {
  if (!button) return () => {};
  const html = button.innerHTML;
  const disabled = button.disabled;
  let shown = false;
  const timer = setTimeout(() => {
    shown = true;
    button.disabled = true;
    button.innerHTML = `<i data-lucide="loader-2" class="spin"></i> ${label}`;
    if (window.lucide) window.lucide.createIcons();
  }, 300);
  return function restore() {
    clearTimeout(timer);
    if (shown) {
      button.disabled = disabled;
      button.innerHTML = html;
      if (window.lucide) window.lucide.createIcons();
    }
  };
}

/* ============ CLOCK / DATE ============ */
function updateClock() {
  const el = document.querySelector('#live-clock');
  if (!el || el.hidden) return;
  const timeEl = document.querySelector('#live-clock-time');
  const zoneEl = document.querySelector('#live-clock-zone');
  if (!timeEl) return;
  const now = new Date();
  const opts = prefs.clockFormat === '24h' ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };
  timeEl.textContent = now.toLocaleTimeString('en-US', opts);
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(now);
    const tz = parts.find(p => p.type === 'timeZoneName');
    zoneEl.textContent = tz ? tz.value : '';
  } catch { zoneEl.textContent = ''; }
}
function startClock() { stopClock(); updateClock(); clockTimer = setInterval(updateClock, 1000); }
function stopClock() { if (clockTimer) clearInterval(clockTimer); clockTimer = null; }
function renderDate() {
  const el = document.querySelector('#current-date');
  if (!el) return;
  const long = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(today).toUpperCase();
  const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(today).toUpperCase();
  const numeric = dateInputValue(today);
  if (prefs.dateFormat === 'short') el.textContent = short;
  else if (prefs.dateFormat === 'numeric') el.textContent = numeric;
  else el.textContent = long;
}

/* ============ MAIN RENDER DISPATCHER ============ */
function render() {
  renderDate();
  if (window.Sidebar?.updateCounts) {
    const total = vehicles.length;
    const overdue = vehicles.filter(v => v.fleetStatus !== 'Retired' && isOverdue(v)).length;
    const dueSoon = vehicles.filter(v => v.fleetStatus !== 'Retired' && isDueSoon(v)).length;
    const svcTotal = overdue + dueSoon;
    const parts = [];
    if (overdue > 0) parts.push(`${overdue} overdue`);
    if (dueSoon > 0) parts.push(`${dueSoon} due soon`);
    const now = new Date();
    const monthCount = vehicles.filter(v => {
      if (!v.dueDate || v.fleetStatus === 'Retired') return false;
      const d = new Date(v.dueDate);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;
    window.Sidebar.updateCounts({ vehicle: total, service: svcTotal, serviceTitle: parts.join(' · ') || '', calendar: monthCount });
  }
  renderOperationalAlerts();
  if (window.OverviewView) window.OverviewView.render();
  if (window.VehiclesView) window.VehiclesView.render();
  if (window.ServiceView) window.ServiceView.render();
  if (window.lucide) window.lucide.createIcons();
  if (typeof renderCalendar === 'function') renderCalendar(vehicles, serviceLog);
}

/* ============ ALERTS ============ */
function getOperationalAlerts() {
  return vehicles.filter(v => v.fleetStatus !== 'Retired' && (isOverdue(v) || isDueSoon(v)))
    .sort((a, b) => Number(isOverdue(b)) - Number(isOverdue(a)) || daysUntil(a.dueDate) - daysUntil(b.dueDate));
}
function categorizeAlert(v) {
  if (isOverdue(v)) return 'overdue';
  if (isDueSoon(v)) return 'duesoon';
  return 'system';
}
function renderAlertCategories() {
  const alerts = getOperationalAlerts();
  const counts = {
    all: alerts.length,
    overdue: alerts.filter(v => getServiceBucket(v) === 'overdue').length,
    duesoon: alerts.filter(v => getServiceBucket(v) === 'due-soon').length
  };
  const container = document.querySelector('#alerts-popover');
  if (!container) return;
  let cats = container.querySelector('.alerts-categories');
  if (!cats) {
    cats = document.createElement('div');
    cats.className = 'alerts-categories';
    const heading = container.querySelector('.alerts-popover-heading');
    if (heading) heading.after(cats);
  }
  cats.innerHTML = `
    <button class="alerts-category ${activeAlertCategory === 'all' ? 'active' : ''}" data-category="all" type="button">All <span class="alerts-category-count">${counts.all}</span></button>
    <button class="alerts-category ${activeAlertCategory === 'overdue' ? 'active' : ''}" data-category="overdue" type="button">Overdue <span class="alerts-category-count">${counts.overdue}</span></button>
    <button class="alerts-category ${activeAlertCategory === 'duesoon' ? 'active' : ''}" data-category="duesoon" type="button">Due soon <span class="alerts-category-count">${counts.duesoon}</span></button>
  `;
  cats.querySelectorAll('.alerts-category').forEach(btn => btn.addEventListener('click', () => { activeAlertCategory = btn.dataset.category; renderOperationalAlerts(); }));
}
function renderOperationalAlerts() {
  const allAlerts = getOperationalAlerts();
  const alerts = activeAlertCategory === 'all' ? allAlerts : allAlerts.filter(v => categorizeAlert(v) === activeAlertCategory);
  const list = document.querySelector('#operational-alert-list');
  if (!list) return;
  list.innerHTML = alerts.map(v => {
    const overdue = isOverdue(v);
    const days = daysUntil(v.dueDate);
    const daysLabel = days < 0 ? `${formatNumber(Math.abs(days))} days overdue` : `${formatNumber(days)} days remaining`;
    return `<li><button class="operational-alert-item" type="button" data-alert-vehicle="${escapeHtml(v.id)}">
      <span class="operational-alert-mark"><i data-lucide="${overdue ? 'triangle-alert' : 'calendar-clock'}"></i></span>
      <span class="operational-alert-copy"><strong>${escapeHtml(v.model)} · ${escapeHtml(v.customer)}</strong><span>${escapeHtml(v.vin)}</span></span>
      <span class="operational-alert-status"><span class="${overdue ? 'is-overdue' : ''}">${overdue ? 'Overdue' : 'Due Soon'}</span><small>${daysLabel}</small></span>
    </button></li>`;
  }).join('');
  const empty = document.querySelector('#alerts-empty');
  if (empty) empty.hidden = alerts.length > 0;
  const scheduleLink = document.querySelector('#alerts-view-schedule');
  if (scheduleLink) scheduleLink.hidden = alerts.length === 0;
  const count = document.querySelector('#notification-count');
  if (count) count.textContent = allAlerts.length;
  renderAlertCategories();
  if (window.lucide) window.lucide.createIcons();
  updateAlertPulse(); 
}

/* ============ VIEW ROUTER ============ */
function setActiveView(view) {
  activeView = view;
  window.Sidebar?.setActive?.(view);
  const titles = {
    overview: ['Fleet overview', 'A clear view of your fleet performance.'],
    vehicles: ['Vehicles', 'A clear view of your vehicles and what needs attention.'],
    service: ['Service schedule', 'Maintenance that keeps your fleet moving.'],
    calendar: ['PMS Calendar', 'Visualize upcoming preventive maintenance.']
  };
  document.querySelector('#page-title').textContent = titles[view][0];
  document.querySelector('.page-subtitle').textContent = titles[view][1];
  document.querySelector('#metrics').hidden = view !== 'overview';
  document.querySelector('#overview-charts').hidden = view !== 'overview';
  document.querySelector('#fleet-section').hidden = view !== 'vehicles';
  document.querySelector('#service-section').hidden = view !== 'service';
  document.querySelector('#calendar-section').hidden = view !== 'calendar';
  document.querySelector('#add-vehicle').hidden = view !== 'vehicles';
  if (view !== 'vehicles') window.VehiclesView?.clearBulkSelection?.();
  render();
}

/* ============ AUTH ============ */
function loadUser() { try { const s = JSON.parse(localStorage.getItem(USER_STORAGE_KEY)); return s && s.email ? s : null; } catch { return null; } }
function saveUser(user) { if (user) localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user)); else localStorage.removeItem(USER_STORAGE_KEY); currentUser = user; }
function applyUserToUI() {
  const avatar = document.querySelector('#user-avatar');
  const name = document.querySelector('#user-name');
  const email = document.querySelector('#user-email');
  if (!currentUser || !avatar) return;
  if (currentUser.picture) avatar.innerHTML = `<img src="${escapeHtml(currentUser.picture)}" alt="" />`;
  else { avatar.textContent = (currentUser.name || currentUser.email).split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase(); }
  name.textContent = currentUser.name || currentUser.email;
  email.textContent = currentUser.role ? `${currentUser.role} · ${currentUser.email}` : currentUser.email;
}
function applyRoleGating() {
  const admin = isAdmin();
  const dashFieldset = document.querySelector('#dashboard-settings-fieldset');
  const dashBanner = document.querySelector('#dashboard-lock-banner');
  const accessBanner = document.querySelector('#access-lock-banner');
  const accessForm = document.querySelector('#access-form');
  const accessRows = document.querySelector('#access-rows');
  if (dashFieldset) dashFieldset.classList.toggle('is-locked', !admin);
  if (dashBanner) dashBanner.hidden = admin;
  if (accessBanner) accessBanner.hidden = admin;
  if (accessForm) accessForm.querySelectorAll('input, select, button').forEach(el => { el.disabled = !admin; });
  if (accessRows) accessRows.querySelectorAll('button').forEach(el => { el.disabled = !admin; });
}
async function bootAfterLogin() {
  try {
    await refreshAccessAccountsFromSheets();
    vehicles = await loadVehiclesFromSheets();
    await loadHistory();
    await loadServiceLog();
    loadPartsList();
    render();
    fetchAndCacheHolidays(currentCalDate.getFullYear());
  } catch (err) {
    console.error('[Fleetline] bootAfterLogin failed:', err);
  }
}
function showApp() {
  document.querySelector('#login-gate').classList.add('hidden');
  document.querySelector('#app-shell').classList.add('visible');
  applyUserToUI(); applyPrefs(); applyRoleGating();
  setActiveView(prefs.defaultView || 'overview');
  renderAccessAccounts(); renderProfileCard(); renderAlertCategories();
  startClock(); startSessionTimer();
}
async function signOut(silent) {
  if (!silent) {
    const ok = await showConfirm({ title: 'Sign out?', description: 'You will need to sign in again to access the fleet dashboard.', variant: 'warning', confirmLabel: 'Sign out' });
    if (!ok) return;
  }
  stopClock(); stopSessionTimer(); closeVehicleDrawer(); closeServiceHistoryDrawer();
  invalidateCache(); localStorage.removeItem(SESSION_TOKEN_KEY); saveUser(null);
  document.querySelector('#app-shell').classList.remove('visible');
  document.querySelector('#login-gate').classList.remove('hidden');
  document.querySelector('#login-form').reset();
  document.querySelector('#login-error').classList.remove('visible');
}

function initLogin() {
  const loginForm = document.querySelector('#login-form');
  const loginEye = document.querySelector('#login-eye');
  const loginEyeIcon = document.querySelector('#login-eye-icon');
  const loginPassword = document.querySelector('#login-password');
  
  if (loginEye) {
    loginEye.addEventListener('click', () => {
      const isPassword = loginPassword.type === 'password';
      loginPassword.type = isPassword ? 'text' : 'password';
      loginEyeIcon.className = isPassword ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
      loginEye.setAttribute('aria-pressed', String(isPassword));
    });
  }

  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    const loginError = document.querySelector('#login-error');
    const loginErrorText = document.querySelector('#login-error-text');
    loginError.classList.remove('visible');
    
    const email = document.querySelector('#login-email').value.trim().toLowerCase();
    const password = loginPassword.value;
    const submitBtn = document.querySelector('#login-submit');
    const originalHTML = submitBtn.innerHTML;
    
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Signing in…</span>';

    try {
      const res = await sheetsPost('login', { email, password });
      if (res.sessionToken) localStorage.setItem(SESSION_TOKEN_KEY, res.sessionToken);
      saveUser(res.user);
      refreshAccessAccountsFromSheets();
      loadHistory();
      loadServiceLog();
      recordActivity(`${res.user.email} signed in`, 'Authentication');
      showApp();
      showToast(`Welcome, ${res.user.name.split(' ')[0]}`);
    } catch (err) {
      loginErrorText.textContent = err.message || 'Sign-in failed.';
      loginError.classList.add('visible');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalHTML;
    }
  });
}

/* ============ VEHICLE DRAWER ============ */
const drawer = document.querySelector('#vehicle-drawer');
const drawerBackdrop = document.querySelector('#vehicle-drawer-backdrop');
let activeDrawerVehicleId = null;

function openVehicleDrawer(vehicle) {
  if (!vehicle || !drawer) return;
  activeDrawerVehicleId = vehicle.id;
  renderVehicleDrawer(vehicle);
  drawer.hidden = false; drawerBackdrop.hidden = false;
  const appShell = document.querySelector('#app-shell');
  if (appShell) appShell.inert = true;
  requestAnimationFrame(() => { drawer.classList.add('visible'); drawerBackdrop.classList.add('visible'); });
  if (window.lucide) window.lucide.createIcons();
}

function closeVehicleDrawer() {
  if (!drawer || drawer.hidden) return;
  drawer.classList.remove('visible');
  drawerBackdrop.classList.remove('visible');
  setTimeout(() => {
    drawer.hidden = true; drawerBackdrop.hidden = true; activeDrawerVehicleId = null;
    const appShell = document.querySelector('#app-shell');
    if (appShell) appShell.inert = false;
  }, 320);
}

function renderVehicleDrawer(v) {
  const complete = isComplete(v);
  const overdue = isOverdue(v);
  const remaining = safeNum(v.threshold) - safeNum(v.odometer);
  const totalKm = safeNum(v.threshold) || 1;
  const pct = complete ? 100 : Math.min(100, Math.max(0, (safeNum(v.odometer) / totalKm) * 100));
  const progressClass = overdue ? 'is-overdue' : complete ? 'is-complete' : '';
  document.querySelector('#vehicle-drawer-title').textContent = v.customer || (v.plate ? `${v.model} · ${v.plate}` : v.model);
  const timelineItems = buildServiceTimeline(v);
  const statusClass = v.fleetStatus === 'Retired' ? 'status-retired' : v.fleetStatus === 'Maintenance Hold' ? 'status-hold' : v.fleetStatus === 'In Service - Due PM' ? 'status-due' : 'status-active';
  document.querySelector('#vehicle-drawer-body').innerHTML = `
    <div class="drawer-col-left">
      <div class="drawer-hero">
        <img src="${getVehicleImage(v.model, v.color, true)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" class="drawer-hero-img" />
        <i class="fa-solid fa-motorcycle" style="display:none; font-size:32px; color:var(--primary); margin-right:12px;"></i>
        <div class="drawer-hero-info">
          <strong>${escapeHtml(v.model)} ${escapeHtml(v.color)}</strong>
          <div class="drawer-status"><span class="status-chip ${statusClass}">${escapeHtml(v.fleetStatus)}</span></div>
        </div>
      </div>
      <div class="drawer-section">
        <div class="drawer-section-title">Overview</div>
        <div class="drawer-fields">
          <div class="drawer-row has-copy">
            <span class="drawer-row-label">VIN</span>
            <span class="drawer-row-value" id="drawer-vin-value">${escapeHtml(v.vin)}</span>
            <button class="drawer-copy-btn" type="button" id="drawer-copy-vin" title="Copy VIN" aria-label="Copy VIN"><i data-lucide="copy"></i></button>
          </div>
          <div class="drawer-row"><span class="drawer-row-label">Plate</span><span class="drawer-row-value">${escapeHtml(v.plate || '—')}</span></div>
          <div class="drawer-row"><span class="drawer-row-label">Sale date</span><span class="drawer-row-value">${formatDate(v.saleDate)}</span></div>
          <div class="drawer-row"><span class="drawer-row-label">Rider</span><span class="drawer-row-value">${escapeHtml(v.rider || '—')}</span></div>
          <div class="drawer-row"><span class="drawer-row-label">Depot</span><span class="drawer-row-value">${escapeHtml(v.depot || '—')}</span></div>
        </div>
      </div>
    </div>
    <div class="drawer-col-right">
      <div class="drawer-section">
        <div class="drawer-section-title">Service progress</div>
        <div class="drawer-progress">
          <div class="drawer-progress-label">
            <span>${escapeHtml(v.lastService || 'No service yet')} → ${escapeHtml(v.nextMilestone)}</span>
            <strong>${complete ? 'Complete' : `${formatNumber(remaining)} km left`}</strong>
          </div>
          <div class="drawer-progress-bar ${progressClass}"><span style="width:${pct}%"></span></div>
        </div>
        <div class="drawer-progress-stats">
          <div class="drawer-kv"><span class="kv-label">Next</span><span class="kv-value">${complete ? '—' : formatShortDate(v.dueDate)}</span></div>
          <div class="drawer-kv"><span class="kv-label">Current Odo</span><span class="kv-value">${formatNumber(v.odometer)} km</span></div>
          <div class="drawer-kv"><span class="kv-label">Threshold</span><span class="kv-value">${complete ? '—' : `${formatNumber(v.threshold)} km`}</span></div>
        </div>
      </div>
      <div class="drawer-section">
        <div class="drawer-section-title">Service timeline</div>
        <div class="drawer-timeline">${timelineItems}</div>
      </div>
      ${v.notes ? `<div class="drawer-section"><div class="drawer-section-title">Notes</div><div class="drawer-notes">${escapeHtml(stripJobOrderBlocks(v.notes) || v.notes)}</div></div>` : ''}
    </div>`;
  const footer = document.querySelector('.vehicle-drawer-footer');
  if (footer) {
    footer.innerHTML = `
      <button class="button button-secondary" id="vehicle-drawer-edit" type="button"><i data-lucide="square-pen"></i> Edit vehicle</button>
      <button class="button button-primary" id="vehicle-drawer-service" type="button"><i data-lucide="wrench"></i> Update service</button>
      <button class="history-btn" id="vehicle-drawer-history" type="button" title="Service history"><i data-lucide="history"></i></button>
      <button class="drawer-delete-btn" id="vehicle-drawer-delete" type="button" title="Delete vehicle"><i data-lucide="trash-2"></i></button>`;
    footer.querySelector('#vehicle-drawer-edit').addEventListener('click', () => { const t = vehicles.find(x => x.id === activeDrawerVehicleId); if (t) openDialog(t); });
    footer.querySelector('#vehicle-drawer-service').addEventListener('click', () => { const t = vehicles.find(x => x.id === activeDrawerVehicleId); if (t) openServiceDialog(t); });
    footer.querySelector('#vehicle-drawer-history').addEventListener('click', () => { const t = vehicles.find(x => x.id === activeDrawerVehicleId); if (t) openServiceHistoryDrawer(t); });
    footer.querySelector('#vehicle-drawer-delete').addEventListener('click', async () => {
      const target = vehicles.find(x => x.id === activeDrawerVehicleId);
      if (!target) return;
      const confirmed = await showConfirm({
        title: 'Delete this vehicle?', description: 'It will be moved to Trash and can be restored from Settings.',
        detail: `<div class="confirm-detail-row"><span>Vehicle</span><strong>${escapeHtml(target.model)}${target.plate ? ` · ${escapeHtml(target.plate)}` : ''}</strong></div>`,
        variant: 'danger', confirmLabel: 'Delete vehicle'
      });
      if (!confirmed) return;
      vehicles = vehicles.filter(x => x.id !== target.id);
      recordActivity(`${target.model}${target.plate ? ` (${target.plate})` : ''} deleted`, 'Vehicles');
      invalidateCache(); closeVehicleDrawer(); render();
      try {
        await sheetsMutate('delete', { id: target.id });
        showToast(`${target.model} moved to Trash`);
        loadHistory().then(() => { if (activeView === 'overview') render(); });
      } catch (err) {
        showErrorToast(`Couldn't delete ${target.model}: ${err.message || 'Unknown error'}`);
        try { vehicles = await loadVehiclesFromSheets({ force: true }); render(); } catch {}
      }
    });
  }
  const copyVinBtn = document.querySelector('#drawer-copy-vin');
  if (copyVinBtn) copyVinBtn.addEventListener('click', async () => {
    const vin = document.querySelector('#drawer-vin-value')?.textContent?.trim() || '';
    if (!vin) return;
    try { await navigator.clipboard.writeText(vin); showToast('VIN copied'); }
    catch { showToast('Could not copy VIN'); }
  });
  if (window.lucide) window.lucide.createIcons();
}

const vehicleDrawerClose = document.querySelector('#vehicle-drawer-close');
if (vehicleDrawerClose) vehicleDrawerClose.addEventListener('click', closeVehicleDrawer);
if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeVehicleDrawer);
document.addEventListener('keydown', e => { 
  if (e.key === 'Escape' && drawer && !drawer.hidden) closeVehicleDrawer(); 
});

function buildServiceTimeline(v) {
  const completedIdx = SERVICE_SCHEDULE.findIndex(s => s.milestone === v.lastService);
  return SERVICE_SCHEDULE.map((s, i) => {
    let state = 'pending', meta = 'Not started', metaClass = 'tl-meta', metaIcon = '';
    if (i <= completedIdx) { state = 'completed'; meta = 'Completed'; metaClass = 'tl-meta tl-meta-complete'; metaIcon = 'check'; }
    else if (i === completedIdx + 1) {
      state = 'is-current';
      const days = daysUntil(v.dueDate);
      if (isComplete(v)) { meta = 'Complete'; metaClass = 'tl-meta tl-meta-complete'; }
      else if (days < 0) { meta = `${Math.abs(days)} days overdue`; metaClass = 'tl-meta tl-meta-overdue'; metaIcon = 'triangle-alert'; }
      else if (days === 0) { meta = 'Due today'; metaClass = 'tl-meta tl-meta-active'; metaIcon = 'clock'; }
      else { meta = `Due in ${days} days`; metaClass = 'tl-meta tl-meta-active'; metaIcon = 'clock'; }
    }
    const iconHtml = metaIcon ? `<i data-lucide="${metaIcon}"></i>` : '';
    const rowClass = state === 'is-current' ? 'drawer-timeline-item is-current' : `drawer-timeline-item ${state}`;
    return `<div class="${rowClass}"><div class="tl-title">${escapeHtml(s.milestone)}</div><div class="${metaClass}">${iconHtml}<span>${escapeHtml(meta)}</span></div></div>`;
  }).join('');
}

/* ============ SERVICE HISTORY DRAWER ============ */
const serviceHistoryDrawer = document.querySelector('#service-history-drawer');
const serviceHistoryBackdrop = document.querySelector('#service-history-backdrop');
function openServiceHistoryDrawer(vehicle) {
  if (!vehicle || !serviceHistoryDrawer) return;
  renderServiceHistoryDrawer(vehicle);
  serviceHistoryDrawer.hidden = false; serviceHistoryBackdrop.hidden = false;
  const appShell = document.querySelector('#app-shell');
  if (appShell) appShell.inert = true;
  requestAnimationFrame(() => { serviceHistoryDrawer.classList.add('visible'); serviceHistoryBackdrop.classList.add('visible'); });
  if (window.lucide) window.lucide.createIcons();
}
function closeServiceHistoryDrawer() {
  if (!serviceHistoryDrawer || serviceHistoryDrawer.hidden) return;
  serviceHistoryDrawer.classList.remove('visible'); serviceHistoryBackdrop.classList.remove('visible');
  setTimeout(() => {
    serviceHistoryDrawer.hidden = true; serviceHistoryBackdrop.hidden = true;
    const appShell = document.querySelector('#app-shell');
    if (appShell) appShell.inert = false;
  }, 320);
}
function renderServiceHistoryDrawer(v) {
  const entries = getServiceLogForVehicle(v.id, v.vin, v.plate);
  document.querySelector('#service-history-title').textContent = v.model + (v.plate ? ` · ${v.plate}` : '');
  document.querySelector('#service-history-subtitle').textContent = entries.length === 0 ? 'No services logged yet' : `${entries.length} ${entries.length === 1 ? 'service' : 'services'} on record`;
  const body = document.querySelector('#service-history-body');
  if (!body) return;
  if (entries.length === 0) {
    body.innerHTML = `<div class="service-history-empty"><span class="empty-icon"><i data-lucide="history"></i></span><strong>No services logged for this vehicle yet.</strong><span>Complete a service to start building the history.</span></div>`;
    if (window.lucide) window.lucide.createIcons();
    return;
  }
  body.innerHTML = entries.map(e => {
    const odo = e.odometer === '' || e.odometer == null ? '—' : `${formatNumber(e.odometer)} km`;
    const tasks = Array.isArray(e.tasksCompleted) ? e.tasksCompleted : [];
    const taskNotes = (e.taskNotes && typeof e.taskNotes === 'object') ? e.taskNotes : {};
    const tasksHtml = tasks.length > 0
      ? `<div class="sh-entry-tasks"><strong>${tasks.length} task${tasks.length === 1 ? '' : 's'} completed</strong><ul>${tasks.map(t => { const note = taskNotes[t]; return `<li>${escapeHtml(t)}${note ? `<span class="sh-task-note">${escapeHtml(note)}</span>` : ''}</li>`; }).join('')}</ul></div>`
      : '';
    return `<div class="service-history-entry">
      <div class="sh-entry-top"><span class="sh-entry-milestone">${escapeHtml(e.milestone)}</span><span class="sh-entry-badge">Completed</span></div>
      <div class="sh-entry-meta">
        ${e.pmsNumber ? `<span>PMS: <strong>${escapeHtml(e.pmsNumber)}</strong></span>` : ''}
        <span><strong>${escapeHtml(formatDateTime(e.completedAt))}</strong></span>
        <span>Odometer: <strong>${odo}</strong></span>
        ${e.mechanic ? `<span>Mechanic: <strong>${escapeHtml(e.mechanic)}</strong></span>` : ''}
      </div>
      <div class="sh-entry-user"><i data-lucide="user-round"></i><span>Closed by <strong>${escapeHtml(e.completedBy || '—')}</strong></span></div>
      ${tasksHtml}
      ${e.notes ? `<div class="sh-entry-notes">${escapeHtml(e.notes)}</div>` : ''}
    </div>`;
  }).join('');
  if (window.lucide) window.lucide.createIcons();
}

const historyCloseBtn = document.querySelector('#service-history-close');
if (historyCloseBtn) historyCloseBtn.addEventListener('click', closeServiceHistoryDrawer);
if (serviceHistoryBackdrop) serviceHistoryBackdrop.addEventListener('click', closeServiceHistoryDrawer);
document.addEventListener('keydown', e => { 
  if (e.key === 'Escape' && serviceHistoryDrawer && !serviceHistoryDrawer.hidden) closeServiceHistoryDrawer(); 
});

/* ============ VEHICLE DIALOG ============ */
const dialog = document.querySelector('#vehicle-dialog');
const form = document.querySelector('#vehicle-form');
function updateServiceFields() {
  const plan = getServicePlan(form.elements.saleDate.value, form.elements.lastService.value);
  form.elements.nextMilestone.value = plan.nextMilestone;
  form.elements.threshold.value = plan.threshold;
  form.elements.dueDate.value = plan.dueDate;
}
function openDialog(v) {
  form.reset(); clearFormErrors(form);
  const errorBanner = document.querySelector('#vehicle-form-error');
  if (errorBanner) errorBanner.hidden = true;
  document.querySelector('#dialog-title').textContent = v ? `Edit ${v.plate || v.model}` : 'Add vehicle';
  form.elements.id.value = v?.id || '';
  if (v) { for (const [k, val] of Object.entries(v)) { if (form.elements[k]) form.elements[k].value = val; } }
  else { form.elements.saleDate.value = dateInputValue(today); form.elements.fleetStatus.value = 'Active In-Service'; }
  updateServiceFields();
  dialog.showModal();
  if (window.lucide) window.lucide.createIcons();
}
function clearFormErrors(formEl) {
  formEl.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
  formEl.querySelectorAll('.field-error').forEach(el => el.remove());
}
function showFieldError(formEl, fieldName, message) {
  const field = formEl.elements[fieldName];
  if (!field) return;
  field.classList.add('invalid');
  const existingError = field.parentElement.querySelector('.field-error');
  if (existingError) existingError.remove();
  const errorEl = document.createElement('div');
  errorEl.className = 'field-error';
  errorEl.textContent = message;
  field.parentElement.appendChild(errorEl);
  field.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function validateForm(formEl) {
  clearFormErrors(formEl);
  let valid = true, firstInvalidField = null;
  const errorBanner = document.querySelector('#vehicle-form-error');
  formEl.querySelectorAll('[required]').forEach(field => {
    if (!field.value.trim()) { valid = false; field.classList.add('invalid'); if (!firstInvalidField) firstInvalidField = field; }
  });
  if (!valid) { if (errorBanner) errorBanner.hidden = false; if (firstInvalidField) firstInvalidField.focus(); }
  else { if (errorBanner) errorBanner.hidden = true; }
  return valid;
}
document.querySelector('#add-vehicle').addEventListener('click', () => openDialog(null));
document.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
document.querySelector('#cancel-dialog').addEventListener('click', () => dialog.close());
form.elements.saleDate.addEventListener('input', updateServiceFields);
form.elements.lastService.addEventListener('change', updateServiceFields);
form.elements.vin.addEventListener('input', e => { 
  const p = e.target.selectionStart; 
  e.target.value = e.target.value.toUpperCase(); 
  e.target.setSelectionRange(p, p); 
  clearFormErrors(form);
});

form.elements.plate.addEventListener('input', e => { 
  const p = e.target.selectionStart; 
  e.target.value = e.target.value.toUpperCase(); 
  e.target.setSelectionRange(p, p); 
  clearFormErrors(form);
});
form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!validateForm(form)) return;
  const raw = Object.fromEntries(new FormData(form).entries());
  const editingId = raw.id || null;
  const validation = validateVehicleData(raw, editingId);
  if (!validation.ok) {
    if (validation.errors.vin) showFieldError(form, 'vin', validation.errors.vin);
    if (validation.errors.plate) showFieldError(form, 'plate', validation.errors.plate);
    return;
  }
  const isEditing = Boolean(raw.id);
  const confirmed = await showConfirm({
    title: isEditing ? 'Save vehicle changes?' : 'Add this vehicle to the fleet?',
    description: isEditing ? `${raw.model} (${raw.plate || raw.vin}) will be updated.` : `${raw.model} (${raw.plate || raw.vin}) will be added to the fleet.`,
    variant: 'warning', confirmLabel: isEditing ? 'Save changes' : 'Add vehicle'
  });
  if (!confirmed) return;
  const submitBtn = form.querySelector('button[type="submit"]');
  const restoreSubmitBtn = withButtonSpinner(submitBtn, isEditing ? 'Saving…' : 'Adding…');
  const idx = vehicles.findIndex(v => v.id === raw.id);
  const existing = idx >= 0 ? vehicles[idx] : null;
  const vin = normalizeVin(raw.vin);
  const plate = normalizePlate(raw.plate);
  let newId;
  if (existing) newId = existing.id;
  else if (plate) newId = plate;
  else newId = `veh-${(crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2))}`;
  const saved = {
    ...existing, ...raw, vin, plate,
    odometer: safeNum(raw.odometer),
    ...getServicePlan(raw.saleDate, raw.lastService),
    currentPmsTicket: existing?.currentPmsTicket && /^NRD-\d+$/.test(existing.currentPmsTicket) ? existing.currentPmsTicket : '',
    workStatus: existing?.workStatus || 'Not Scheduled',
    scheduledDate: existing?.scheduledDate || '',
    actualOdo: existing?.actualOdo ?? '',
    notes: existing?.notes || '',
    id: newId
  };
  if (idx >= 0) vehicles[idx] = saved; else vehicles.unshift(saved);
  recordActivity(`${saved.model}${saved.plate ? ` (${saved.plate})` : ''} ${existing ? 'updated' : 'added'}`, 'Vehicles');
  invalidateCache(); dialog.close(); render();
  if (activeDrawerVehicleId === saved.id) openVehicleDrawer(saved);
  try {
    await sheetsMutate(existing ? 'update' : 'add', { vehicle: saved });
    writeCache(vehicles);
    showToast(`${saved.model}${saved.plate ? ` (${saved.plate})` : ''} ${existing ? 'updated' : 'added'}`);
    loadHistory().then(() => { if (activeView === 'overview') render(); });
  } catch (err) {
    showErrorToast(`Couldn't save ${saved.model}: ${err.message || 'Unknown error'}`);
    try { vehicles = await loadVehiclesFromSheets({ force: true }); render(); } catch {}
  } finally { restoreSubmitBtn(); }
});

/* ============ JOB ORDER: MARKER-BASED PARSER ============ */
/**
 * Strip any job-order block (new markers OR legacy [Issue]/[Parts Used]/[Remarks])
 * from a notes string, returning only the preserved free-text before the block.
 */
function stripJobOrderBlocks(notes) {
  const text = String(notes || '');
  // Check for new markers first
  const newStart = text.indexOf(JO_MARKERS.issue);
  const legacyStart = Math.min(
    ...[ '[Issue]', '[Parts Used]', '[Remarks]' ]
      .map(m => { const i = text.indexOf(m); return i === -1 ? Infinity : i; })
  );
  const start = Math.min(newStart === -1 ? Infinity : newStart, legacyStart);
  if (start === Infinity) return text.trim();
  return text.slice(0, start).trim();
}

/**
 * Parse a job-order block (new markers OR legacy) out of a notes string.
 * Returns { preserved, issue, parts: [{qty, desc, uom}], remarks }.
 */
function parseJobOrderBlocks(notes) {
  const out = { preserved: '', issue: '', parts: [], remarks: '' };
  const text = String(notes || '');

  // Prefer new markers
  const newStart = text.indexOf(JO_MARKERS.issue);
  const legacyIssue = text.indexOf('[Issue]');
  const legacyParts = text.indexOf('[Parts Used]');
  const legacyRem   = text.indexOf('[Remarks]');
  const legacyStart = Math.min(
    ...[legacyIssue, legacyParts, legacyRem].filter(i => i !== -1)
  );

  if (newStart === -1 && legacyStart === Infinity) {
    out.preserved = text.trim();
    return out;
  }

  // --- New marker format ---
  if (newStart !== -1 && (legacyStart === Infinity || newStart <= legacyStart)) {
    out.preserved = text.slice(0, newStart).trim();
    const block = text.slice(newStart);
    const pStart = block.indexOf(JO_MARKERS.parts);
    const rStart = block.indexOf(JO_MARKERS.remarks);
    const eStart = block.indexOf(JO_MARKERS.end);

    if (pStart !== -1) {
      out.issue = block.slice(JO_MARKERS.issue.length, pStart).trim();
    } else if (rStart !== -1) {
      out.issue = block.slice(JO_MARKERS.issue.length, rStart).trim();
    } else {
      out.issue = block.slice(JO_MARKERS.issue.length).trim();
    }

    if (pStart !== -1) {
      const pEnd = rStart !== -1 ? rStart : (eStart !== -1 ? eStart : block.length);
      const rawParts = block.slice(pStart + JO_MARKERS.parts.length, pEnd).trim();
      if (rawParts) {
        out.parts = rawParts.split(/\s*\|\s*/).map(entry => {
          const m = entry.match(/^(\d+)\s*x\s+(.+?)(?:\s*\(([^)]*)\))?$/i);
          if (m) return { qty: m[1], desc: m[2].trim(), uom: (m[3] || '').trim() };
          return { qty: '', desc: entry.trim(), uom: '' };
        }).filter(p => p.desc);
      }
    }

    if (rStart !== -1) {
      const rEnd = eStart !== -1 ? eStart : block.length;
      out.remarks = block.slice(rStart + JO_MARKERS.remarks.length, rEnd).trim();
    }
    return out;
  }

  // --- Legacy [Issue]/[Parts Used]/[Remarks] format ---
  out.preserved = text.slice(0, legacyStart).trim();
  const block = text.slice(legacyStart);

  const issueMatch = block.match(/\[Issue\]\s*([\s\S]*?)(?=\n?\[(?:Parts Used|Remarks)\]|$)/);
  if (issueMatch) out.issue = issueMatch[1].trim();

  const partsMatch = block.match(/\[Parts Used\]\s*([^\n]*)/);
  if (partsMatch && partsMatch[1].trim()) {
    out.parts = partsMatch[1].trim().split(/\s*,\s*/).map(entry => {
      const m = entry.match(/^(\d+)\s*x\s+(.+?)(?:\s*\(([^)]*)\))?$/i);
      if (m) return { qty: m[1], desc: m[2].trim(), uom: (m[3] || '').trim() };
      return { qty: '', desc: entry.trim(), uom: '' };
    }).filter(p => p.desc);
  }

  const remMatch = block.match(/\[Remarks\]\s*([\s\S]*)$/);
  if (remMatch) out.remarks = remMatch[1].trim();

  return out;
}

/**
 * Fill the Job Order parts table from [{qty, desc, uom}].
 * Clears existing values first so re-opens don't stack.
 */
function fillJobOrderParts(parts) {
  const rows = document.querySelectorAll('.jo-table tbody tr');
  rows.forEach((row, i) => {
    const codeInput   = row.querySelector('.part-code-input');
    const descInput   = row.querySelector('.part-desc-input');
    const statusInput = row.children[2]?.querySelector('input');
    const qtyInput    = row.children[3]?.querySelector('input');
    const uomInput    = row.children[4]?.querySelector('input');

    [codeInput, descInput, statusInput, qtyInput, uomInput].forEach(el => {
      if (el) el.value = '';
    });

    const p = parts[i];
    if (!p) return;

    const match = partsCache.find(x =>
      String(x.description).toLowerCase() === String(p.desc).toLowerCase()
    );
    if (match && codeInput) codeInput.value = match.itemCode;
    if (descInput) descInput.value = p.desc || '';
    if (qtyInput) qtyInput.value = p.qty || '';
    if (uomInput) uomInput.value = p.uom || '';
  });
}

/* ============ SERVICE DIALOG ============ */
const serviceDialog = document.querySelector('#service-dialog');
const serviceForm = document.querySelector('#service-form');
let activeServiceVehicleId = null;

function updateCompleteButtonState() {
  const btn = document.querySelector('#service-complete');
  const startBtn = document.querySelector('#service-start-btn');
  const saveBtn = document.querySelector('#service-save-btn');
  const hint = document.querySelector('#service-complete-hint');
  
  if (!btn) return;
  const vehicle = vehicles.find(x => x.id === activeServiceVehicleId);
  if (!vehicle) return;
  
  if (isComplete(vehicle)) { 
    btn.style.display = 'none'; 
    if (hint) hint.hidden = true; 
    if (startBtn) startBtn.style.display = 'none';
    if (saveBtn) saveBtn.style.display = '';
    return; 
  }
  
  btn.style.display = '';
  
  const savedIsInProgress = vehicle.workStatus === 'In Progress';
  const formIsInProgress = serviceForm.elements.workStatus.value === 'In Progress';
  const formIsDirty = serviceForm.elements.workStatus.value !== vehicle.workStatus;
  
  if (startBtn && saveBtn) {
    const hasDate = !!vehicle.scheduledDate;
    const isScheduled = vehicle.workStatus === 'Scheduled' || vehicle.workStatus === 'On Hold';

    if (savedIsInProgress) {
      startBtn.style.display = 'none';
      saveBtn.style.display = '';
    } 
    else if (isScheduled && hasDate) {
      startBtn.style.display = '';
      startBtn.disabled = false;
      saveBtn.style.display = '';
    } 
    else {
      startBtn.style.display = '';
      startBtn.disabled = true;
      saveBtn.style.display = '';
    }
  }

  btn.disabled = !savedIsInProgress;
  btn.title = savedIsInProgress ? 'Mark this service as completed' : "Save the schedule with work status 'In Progress' before completing";
  
  if (hint) {
    hint.hidden = !(formIsInProgress && formIsDirty && !savedIsInProgress);
    if (!hint.hidden) hint.textContent = 'Save schedule to enable completion.';
  }
}

/* --- GATHER JOB ORDER DATA (new marker format) --- */
function gatherJobOrderData() {
  const description = document.getElementById('jo-description').value.trim();
  const remarks = document.querySelector('.jo-remarks textarea').value.trim();

  const parts = [];
  const rows = document.querySelectorAll('.jo-table tbody tr');
  rows.forEach(row => {
    const code = row.querySelector('.part-code-input')?.value.trim();
    const desc = row.querySelector('.part-desc-input')?.value.trim();
    const qty  = row.children[3]?.querySelector('input')?.value.trim();
    const uom  = row.children[4]?.querySelector('input')?.value.trim();

    if (code || desc || qty) {
      const label = desc || code;
      const qtyPart = qty ? `${qty}x ` : '';
      const uomPart = uom ? ` (${uom})` : '';
      parts.push(`${qtyPart}${label}${uomPart}`);
    }
  });

  if (!description && parts.length === 0 && !remarks) return '';

  let block = JO_MARKERS.issue + '\n' + (description || '');
  block += '\n' + JO_MARKERS.parts + '\n' + parts.join(' | ');
  block += '\n' + JO_MARKERS.remarks + '\n' + (remarks || '');
  block += '\n' + JO_MARKERS.end;
  return block.trim();
}

/* --- SAVE JOB ORDER NOTES (strips old block, writes new) --- */
async function saveJobOrderNotes() {
  const v = vehicles.find(x => x.id === activeServiceVehicleId);
  if (!v) return false;

  const newNotes = gatherJobOrderData();
  const preservedNotes = stripJobOrderBlocks(v.notes);

  if (!newNotes && !preservedNotes) return true;

  v.notes = [preservedNotes, newNotes].filter(Boolean).join('\n\n');

  try {
    await sheetsMutate('update', { vehicle: v });
    writeCache(vehicles);
    if (serviceForm.elements.notes) serviceForm.elements.notes.value = v.notes;
    return true;
  } catch (err) {
    showErrorToast(`Couldn't save notes: ${err.message}`);
    return false;
  }
}

/* --- JOB ORDER PRINT LOGIC --- */
function printJobOrder() {
  const v = vehicles.find(x => x.id === activeServiceVehicleId);
  if (!v) return;

  try {
    document.getElementById('jo-pms').textContent = v.currentPmsTicket || 'N/A';
    document.getElementById('jo-date').textContent = new Date().toLocaleDateString('en-US');
    document.getElementById('jo-name').value = v.rider || '';
    document.getElementById('jo-company').value = v.customer || '';
    document.getElementById('jo-model').value = v.model || '';
    document.getElementById('jo-vin').value = v.vin || '';
    document.getElementById('jo-plate').value = v.plate || '';
    document.getElementById('jo-odo').value = v.odometer ? `${formatNumber(v.odometer)} km` : '';

    // Parse saved block back into form fields
    const rawNotes = serviceForm.elements.notes?.value?.trim() || v.notes || '';
    const parsed = parseJobOrderBlocks(rawNotes);

    // Description prefills with [Issue] section (or preserved free-text)
    document.getElementById('jo-description').value =
      parsed.issue || parsed.preserved || '';

    // Parts table
    fillJobOrderParts(parsed.parts);

    // Remarks
    const remarksEl = document.querySelector('.jo-remarks textarea');
    if (remarksEl) remarksEl.value = parsed.remarks || '';

    const joDialog = document.querySelector('#job-order-dialog');
    if (joDialog) {
      joDialog.showModal();
      if (window.lucide) window.lucide.createIcons();
    }
  } catch (err) {
    console.error("Error opening Job Order:", err);
    showErrorToast("Could not open Job Order form.");
  }
}

document.querySelector('#jo-close-btn')?.addEventListener('click', () => {
  const d = document.querySelector('#job-order-dialog');
  if (d) d.close();
});

document.querySelector('#jo-save-btn')?.addEventListener('click', async () => {
  const btn = document.querySelector('#jo-save-btn');
  const restore = withButtonSpinner(btn, 'Saving…');
  
  await new Promise(r => setTimeout(r, 400)); 
  const success = await saveJobOrderNotes();
  
  restore();
  if (success) {
    showToast('Job Order details saved to notes');
    document.querySelector('#job-order-dialog').close();
  }
});

document.querySelector('#jo-print-btn')?.addEventListener('click', async () => {
  const btn = document.querySelector('#jo-print-btn');
  const joDialog = document.querySelector('#job-order-dialog');
  const restore = withButtonSpinner(btn, 'Preparing…');
  
  await new Promise(r => setTimeout(r, 400));
  const success = await saveJobOrderNotes();
  restore();
  
  if (success) {
    showToast('Job Order saved — opening print dialog');
    joDialog.close();
    setTimeout(() => {
      window.print();
      joDialog.showModal();
    }, 200); 
  }
});

/* ============ SERVICE DIALOG ============ */
function openServiceDialog(v) {
  serviceForm.reset(); clearFormErrors(serviceForm);
  activeServiceVehicleId = v.id;
  serviceForm.elements.vehicleId.value = v.id;
  serviceForm.elements.pmsNumber.value = v.currentPmsTicket || '';
  serviceForm.elements.vin.value = v.vin;
  serviceForm.elements.currentService.value = v.lastService || 'No service yet';
  serviceForm.elements.dueStatus.value = isOverdue(v) ? 'Overdue' : 'Due Soon';
  serviceForm.elements.workStatus.value = v.workStatus;
  serviceForm.elements.scheduledDate.value = v.scheduledDate;
  serviceForm.elements.currentOdo.value = v.odometer ? `${formatNumber(v.odometer)} km` : '';
  serviceForm.elements.actualOdo.value = v.actualOdo;
  serviceForm.elements.notes.value = v.notes;
  serviceForm.elements.mechanic.value = v.mechanic || '';
  document.querySelector('#service-dialog-title').textContent = v.currentPmsTicket || (v.plate || v.model);
  updateChecklistButtonLabel(v);
  const toggleBtn = document.querySelector('#service-checklist-toggle');
  const hasTasks = getChecklistForMilestone(v.nextMilestone).length > 0;
  if (toggleBtn) toggleBtn.style.display = hasTasks ? '' : 'none';
  serviceDialog.showModal();
  if (window.lucide) window.lucide.createIcons();
  updateCompleteButtonState();
}

document.querySelector('.service-close').addEventListener('click', () => { closeChecklistDialog(); serviceDialog.close(); });

document.querySelector('#service-print-btn')?.addEventListener('click', () => {
  serviceDialog.close();
  printJobOrder();
});

const scheduledDateInput = serviceForm.elements.scheduledDate;
if (scheduledDateInput) {
  scheduledDateInput.addEventListener('change', (e) => {
    if (e.target.value && serviceForm.elements.workStatus.value === 'Not Scheduled') {
      serviceForm.elements.workStatus.value = 'Scheduled';
      updateCompleteButtonState();
    }
  });
}

document.querySelector('#service-start-btn')?.addEventListener('click', async () => {
  const v = vehicles.find(x => x.id === activeServiceVehicleId);
  if (!v) return;

  const startBtn = document.querySelector('#service-start-btn');
  const restoreStartBtn = withButtonSpinner(startBtn, 'Starting…');
  const snapshot = { ...v };

  try {
    if (!v.currentPmsTicket) {
      const res = await sheetsGet('getNextPms');
      if (res.ok && res.nextPms) {
        v.currentPmsTicket = res.nextPms;
        serviceForm.elements.pmsNumber.value = res.nextPms;
        document.querySelector('#service-dialog-title').textContent = res.nextPms;
      }
    }

    v.workStatus = 'In Progress';
    serviceForm.elements.workStatus.value = 'In Progress';
    
    await sheetsMutate('update', { vehicle: v });
    writeCache(vehicles);
    showToast(`${v.model} service started`);
    updateCompleteButtonState();
    
    if (window.ServiceView) window.ServiceView.render();
  } catch (err) {
    const idx = vehicles.findIndex(x => x.id === snapshot.id);
    if (idx >= 0) vehicles[idx] = snapshot;
    serviceForm.elements.workStatus.value = snapshot.workStatus;
    showErrorToast(`Couldn't start service: ${err.message || 'Unknown error'}`);
    updateCompleteButtonState();
  } finally {
    restoreStartBtn();
  }
});

serviceForm.addEventListener('submit', async e => {
  e.preventDefault();
  const confirmed = await showConfirm({ title: 'Save service changes?', description: `The service record for ${serviceForm.elements.pmsNumber.value} will be updated.`, variant: 'warning', confirmLabel: 'Confirm' });
  if (!confirmed) return;
  
  const data = Object.fromEntries(new FormData(serviceForm).entries());
  const v = vehicles.find(x => x.id === data.vehicleId);
  if (!v) return;
  
  const saveBtn = serviceForm.querySelector('button[type="submit"]');
  const restoreSaveBtn = withButtonSpinner(saveBtn, 'Saving…');
  const snapshot = { ...v };
  
  const oldWorkStatus = v.workStatus;
  
  v.workStatus = data.workStatus;
  v.scheduledDate = data.scheduledDate;
  v.actualOdo = data.actualOdo === '' ? '' : safeNum(data.actualOdo);
  v.notes = data.notes.trim();
  v.mechanic = data.mechanic; 

  // --- AUTO-SWITCH FLEET STATUS LOGIC ---
  const isHoldOrRetired = v.fleetStatus === 'Maintenance Hold' || v.fleetStatus === 'Retired';
  
  if (!isHoldOrRetired) {
    // If it's scheduled or in progress, set to Due PM
    if (v.workStatus === 'Scheduled' || v.workStatus === 'In Progress' || v.workStatus === 'On Hold') {
      v.fleetStatus = 'In Service - Due PM';
    } 
    // If moved back to Not Scheduled, revert to Active
    else if (v.workStatus === 'Not Scheduled') {
      v.fleetStatus = 'Active In-Service';
    }
  }

  recordActivity(`${v.model} service record updated`, 'Service schedule');
  invalidateCache();
  
  const localIdx = vehicles.findIndex(x => x.id === v.id);
  if (localIdx >= 0) vehicles[localIdx] = v;
  
  try {
    await sheetsMutate('update', { vehicle: v });
    writeCache(vehicles);
    showToast(`Service schedule saved for ${v.model}`);
    updateCompleteButtonState();
    if (window.ServiceView) window.ServiceView.render();

    serviceForm.elements.mechanic.value = v.mechanic || '';
    
    loadHistory().then(() => { if (activeView === 'overview') render(); });
  } catch (err) {
    showErrorToast(`Couldn't save service for ${v.model}: ${err.message || 'Unknown error'}`);
    const idx = vehicles.findIndex(x => x.id === snapshot.id);
    if (idx >= 0) vehicles[idx] = snapshot;
    updateCompleteButtonState();
    try { vehicles = await loadVehiclesFromSheets({ force: true }); render(); } catch {}
  } finally { restoreSaveBtn(); }
});

serviceForm.elements.workStatus.addEventListener('change', (e) => {
  if (e.target.value === 'Not Scheduled') {
    serviceForm.elements.scheduledDate.value = '';
    serviceForm.elements.actualOdo.value = '';
    serviceForm.elements.notes.value = '';
  }
  updateCompleteButtonState();
});

document.querySelector('#service-complete').addEventListener('click', async () => {
  const v = vehicles.find(x => x.id === activeServiceVehicleId);
  if (!v) return;
  if (serviceForm.elements.workStatus.value !== 'In Progress') { showToast("Set work status to 'In Progress' before completing."); return; }
  const actualOdo = serviceForm.elements.actualOdo.value.trim();
  if (actualOdo === '') { showFieldError(serviceForm, 'actualOdo', 'Enter the odometer reading at completion.'); serviceForm.elements.actualOdo.focus(); return; }
  const currentMilestone = v.nextMilestone;
  const plan = getServicePlan(v.saleDate, currentMilestone);
  const nextName = plan.nextMilestone;
  const isLast = nextName === 'All Complete';
  const confirmed = await showConfirm({
    title: `Mark ${currentMilestone} as complete?`,
    description: isLast ? `${v.model} will complete all scheduled services. No further services remain on the plan.` : `${v.model} (${v.plate || v.vin}) will advance to ${nextName}.`,
    detail: isLast ? `<div class="confirm-detail-row"><span>Final milestone</span><strong>${escapeHtml(currentMilestone)}</strong></div>` : `<div class="confirm-detail-row"><span>Next service</span><strong>${escapeHtml(nextName)}</strong></div><div class="confirm-detail-row"><span>Due date</span><strong>${escapeHtml(plan.dueDate)}</strong></div>`,
    variant: 'success', confirmLabel: 'Mark complete'
  });
  if (!confirmed) return;
  const completeBtn = document.querySelector('#service-complete');
  const restoreCompleteBtn = withButtonSpinner(completeBtn, 'Completing…');
  const snapshot = { ...v };
  const notesFromForm = serviceForm.elements.notes.value.trim();
  const idx = vehicles.findIndex(x => x.id === v.id);
  
  // --- NEW: Auto-revert Fleet Status upon completion ---
  const isHoldOrRetired = v.fleetStatus === 'Maintenance Hold' || v.fleetStatus === 'Retired';
  const newFleetStatus = isHoldOrRetired ? v.fleetStatus : 'Active In-Service';

  const updated = { 
    ...v, 
    lastService: currentMilestone, 
    ...plan, 
    odometer: safeNum(actualOdo), 
    actualOdo: safeNum(actualOdo), 
    workStatus: 'Not Scheduled', 
    scheduledDate: '', 
    fleetStatus: newFleetStatus, // <--- Apply the new Fleet Status
    notes: notesFromForm || v.notes || '' 
  };
  vehicles[idx] = updated;
  
  const checklistActions = {};
  getChecklistForMilestone(currentMilestone).forEach(t => { checklistActions[t.item] = t.action; });
  const logEntry = {
    pmsNumber: snapshot.currentPmsTicket || '', vehicleId: snapshot.id, vin: snapshot.vin, plate: snapshot.plate || '',
    model: snapshot.model, customer: snapshot.customer, milestone: currentMilestone,
    odometer: safeNum(actualOdo), completedAt: new Date().toISOString(), completedBy: currentUser?.email || '',
    mechanic: serviceForm.elements.mechanic.value,
    notes: notesFromForm || '', tasksCompleted: getCheckedTasksForVehicle(snapshot),
    taskNotes: getNotesForVehicle(snapshot), checklistActions
  };
  recordActivity(`${v.model} completed ${currentMilestone}`, 'Service schedule');
  invalidateCache();
  closeChecklistDialog(); serviceDialog.close(); render();
  if (activeDrawerVehicleId === v.id) openVehicleDrawer(updated);
  try {
    await sheetsMutate('update', { vehicle: updated });
    writeCache(vehicles);
    try { await appendServiceLogEntry(logEntry); }
    catch { showErrorToast(`${v.model} completed, but the service log entry couldn't be saved.`); }
    clearCheckedTasksForVehicle(snapshot); clearNotesForVehicle(snapshot);
    persistChecklistState(); persistChecklistNotes();
    showToast(`${v.model} · ${currentMilestone} completed`);
    loadHistory().then(() => { if (activeView === 'overview') render(); });
  } catch (err) {
    showErrorToast(`Couldn't complete ${v.model}: ${err.message || 'Unknown error'}`);
    vehicles[idx] = snapshot; render();
    if (activeDrawerVehicleId === v.id) openVehicleDrawer(snapshot);
    try { vehicles = await loadVehiclesFromSheets({ force: true }); render(); } catch {}
  } finally { restoreCompleteBtn(); }
});

/* ============ SETTINGS ============ */
const settingsDialog = document.querySelector('#settings-dialog');
function openSettings() {
  document.querySelector('#access-message').textContent = '';
  document.querySelector('#profile-message') && (document.querySelector('#profile-message').textContent = '');
  renderAccessAccounts(); renderProfileCard(); applyRoleGating();
  switchSettingsTab('dashboard');
  settingsDialog.showModal();
  refreshAccessAccountsFromSheets();
  if (window.lucide) window.lucide.createIcons();
}
function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
  if (tab === 'trash') renderTrash();
  if (tab === 'audit') refreshAuditLog();
}
document.querySelectorAll('.settings-tab').forEach(tab => tab.addEventListener('click', () => switchSettingsTab(tab.dataset.tab)));
document.querySelector('.settings-close').addEventListener('click', () => settingsDialog.close());
document.querySelectorAll('.density-switch button').forEach(btn => btn.addEventListener('click', () => {
  const d = btn.dataset.density;
  if (!d || d === prefs.density) return;
  prefs.density = d; savePrefs(); applyPrefs(); flashAutoSave('Density updated');
}));
function bindPrefSelect(id, key, afterFn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', e => { if (!isAdmin()) return; prefs[key] = e.target.value; savePrefs(); applyPrefs(); if (afterFn) afterFn(); flashAutoSave(); });
}
function bindPrefToggle(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', e => { if (!isAdmin()) return; prefs[key] = e.target.checked; savePrefs(); applyPrefs(); flashAutoSave(); });
}
bindPrefSelect('set-density', 'density');
bindPrefSelect('set-date-format', 'dateFormat', () => render());
bindPrefSelect('set-default-view', 'defaultView');
bindPrefSelect('set-clock-format', 'clockFormat');
bindPrefSelect('set-service-logic', 'serviceLogic');
bindPrefToggle('set-show-alerts', 'showAlerts');
bindPrefToggle('set-show-help', 'showHelp');
bindPrefToggle('set-compact-heading', 'compactHeading');
bindPrefToggle('set-reduce-motion', 'reduceMotion');
document.querySelector('#set-reset').addEventListener('click', async () => {
  if (!isAdmin()) return;
  const ok = await showConfirm({ title: 'Reset all settings?', description: 'Density, date format, and all other preferences will return to their defaults.', variant: 'warning', confirmLabel: 'Reset settings' });
  if (!ok) return;
  prefs = { ...DEFAULT_PREFS }; savePrefs(); applyPrefs(); render();
  flashAutoSave('Settings reset'); showToast('Settings reset to defaults');
});

/* ============ TRASH ============ */
async function renderTrash() {
  const tbody = document.querySelector('#trash-rows');
  const empty = document.querySelector('#trash-empty');
  if (!tbody) return;
  try {
    const { vehicles: rows } = await sheetsGet('deletedVehicles');
    const list = Array.isArray(rows) ? rows : [];
    tbody.innerHTML = list.map(v => `<tr>
      <td><strong>${escapeHtml(v.model)}</strong>${v.plate ? ` · ${escapeHtml(v.plate)}` : ''}</td>
      <td>${escapeHtml(v.vin)}</td>
      <td>${escapeHtml(v.deletedAt || '—')}</td>
      <td><button class="button button-secondary" type="button" data-restore-vehicle="${escapeHtml(v.id)}"><i data-lucide="rotate-ccw"></i> Restore</button></td>
    </tr>`).join('');
    if (empty) empty.hidden = list.length > 0;
    if (window.lucide) window.lucide.createIcons();
  } catch (err) { console.warn(err); tbody.innerHTML = ''; if (empty) empty.hidden = false; }
}
document.querySelector('#trash-rows')?.addEventListener('click', async e => {
  const btn = e.target.closest('[data-restore-vehicle]');
  if (!btn) return;
  const ok = await showConfirm({ title: 'Restore this vehicle?', description: 'It will reappear in the fleet.', variant: 'success', confirmLabel: 'Restore' });
  if (!ok) return;
  try {
    await sheetsPost('restore', { id: btn.dataset.restoreVehicle });
    showToast('Vehicle restored');
    vehicles = await loadVehiclesFromSheets({ force: true });
    render(); renderTrash();
  } catch (err) { showErrorToast('Restore failed: ' + err.message); }
});

/* ============ AUDIT ============ */
let auditLogCache = [];
async function loadAuditLog() {
  try { const { entries } = await sheetsGet('auditLog'); auditLogCache = Array.isArray(entries) ? entries : []; }
  catch (err) { console.warn(err); auditLogCache = []; }
}
function actionLabel(action) {
  const m = { add: 'Add vehicle', update: 'Update vehicle', delete: 'Delete vehicle', restore: 'Restore vehicle', complete: 'Complete service', addUser: 'Add user', removeUser: 'Remove user', resetPassword: 'Reset password' };
  return m[action] || action;
}
function actionClass(action) {
  if (action === 'delete' || action === 'removeUser') return 'audit-action-danger';
  if (action === 'add' || action === 'addUser' || action === 'complete') return 'audit-action-success';
  if (action === 'update' || action === 'resetPassword') return 'audit-action-info';
  if (action === 'restore') return 'audit-action-warning';
  return '';
}
function renderAuditLogFilters() {
  const actorSelect = document.querySelector('#audit-filter-actor');
  if (!actorSelect) return;
  const current = actorSelect.value;
  const actors = [...new Set(auditLogCache.map(e => e['Actor']).filter(Boolean))].sort();
  actorSelect.innerHTML = '<option value="">All users</option>' + actors.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
  if (actors.includes(current)) actorSelect.value = current;
}
function renderAuditLog() {
  const tbody = document.querySelector('#audit-rows');
  const empty = document.querySelector('#audit-empty');
  const count = document.querySelector('#audit-count');
  const banner = document.querySelector('#audit-lock-banner');
  if (!tbody) return;
  if (banner) banner.hidden = isAdmin();
  const needle = (document.querySelector('#audit-search')?.value || '').trim().toLowerCase();
  const filterAction = document.querySelector('#audit-filter-action')?.value || '';
  const filterActor = document.querySelector('#audit-filter-actor')?.value || '';
  let list = auditLogCache;
  if (filterAction) list = list.filter(e => (e['Action'] || '') === filterAction);
  if (filterActor) list = list.filter(e => (e['Actor'] || '') === filterActor);
  if (needle) list = list.filter(e => ['Timestamp', 'Actor', 'Action', 'Target', 'Details'].some(k => String(e[k] || '').toLowerCase().includes(needle)));
  const shown = list.slice(0, 200);
  if (shown.length === 0) { tbody.innerHTML = ''; if (empty) empty.hidden = false; if (count) count.textContent = '0 entries'; return; }
  if (empty) empty.hidden = true;
  if (count) count.textContent = `${shown.length} entr${shown.length === 1 ? 'y' : 'ies'}`;
  tbody.innerHTML = shown.map(e => `<tr>
    <td class="audit-cell-timestamp">${escapeHtml(e['Timestamp'] || '')}</td>
    <td class="audit-cell-actor">${escapeHtml(e['Actor'] || '')}</td>
    <td><span class="audit-action ${actionClass(e['Action'])}">${escapeHtml(actionLabel(e['Action']))}</span></td>
    <td class="audit-cell-target">${escapeHtml(e['Target'] || '')}</td>
    <td class="audit-cell-details">${escapeHtml(e['Details'] || '')}</td>
  </tr>`).join('');
}
async function refreshAuditLog() { await loadAuditLog(); renderAuditLogFilters(); renderAuditLog(); }
document.querySelector('#audit-search')?.addEventListener('input', () => renderAuditLog());
document.querySelector('#audit-filter-action')?.addEventListener('change', () => renderAuditLog());
document.querySelector('#audit-filter-actor')?.addEventListener('change', () => renderAuditLog());

/* ============ ACCESS ============ */
function roleBadgeClass(role) {
  if (role === 'Admin') return 'role-admin';
  if (role === 'Fleet manager') return 'role-fleet';
  if (role === 'Service coordinator') return 'role-service';
  return 'role-viewer';
}
function renderAccessAccounts() {
  const countEl = document.querySelector('#access-list-count');
  if (countEl) countEl.textContent = `${accessAccounts.length} ${accessAccounts.length === 1 ? 'account' : 'accounts'}`;
  const tbody = document.querySelector('#access-rows');
  if (!tbody) return;
  tbody.innerHTML = accessAccounts.map((a, i) => {
    const isPrimary = a.isPrimary || a.email === DEFAULT_ADMIN_EMAIL;
    const disabled = !isAdmin() ? 'disabled' : '';
    return `<tr>
      <td class="access-email">${escapeHtml(a.email)}${isPrimary ? ' <span style="color:var(--primary);font-size:10px;font-weight:700">· PRIMARY</span>' : ''}</td>
      <td><span class="role-badge ${roleBadgeClass(a.role)}">${escapeHtml(a.role)}</span></td>
      <td>${escapeHtml(a.addedAt || '—')}</td>
      <td><div class="access-actions">
        <button class="row-action row-edit" type="button" data-reset-password="${i}" title="Reset password" ${disabled}><i data-lucide="key-round"></i></button>
        ${isPrimary ? '' : `<button class="row-action row-delete" type="button" data-remove-access="${i}" title="Remove" ${disabled}><i data-lucide="user-round-minus"></i></button>`}
      </div></td>
    </tr>`;
  }).join('');
  const empty = document.querySelector('#access-empty');
  if (empty) empty.hidden = accessAccounts.length > 0;
  if (window.lucide) window.lucide.createIcons();
}
const accessForm = document.querySelector('#access-form');
accessForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (!isAdmin()) return;
  const data = Object.fromEntries(new FormData(accessForm).entries());
  const email = data.email.trim().toLowerCase();
  const { password, passwordConfirm, role } = data;
  const message = document.querySelector('#access-message');
  if (password !== passwordConfirm) { message.textContent = 'Passwords do not match.'; message.classList.add('is-error'); return; }
  if (password.length < 6) { message.textContent = 'Password must be at least 6 characters.'; message.classList.add('is-error'); return; }
  const ok = await showConfirm({
    title: 'Add this user?', description: 'They will be able to sign in with their email and temporary password.',
    detail: `<div class="confirm-detail-row"><span>Email</span><strong>${escapeHtml(email)}</strong></div><div class="confirm-detail-row"><span>Role</span><strong>${escapeHtml(role)}</strong></div>`,
    variant: 'warning', confirmLabel: 'Add user'
  });
  if (!ok) return;
  try {
    await sheetsPost('addUser', { user: { email, password, role } });
    recordActivity(`Added ${email} (${role})`, 'User access');
    showToast(`${email} added as ${role}`);
    accessForm.reset();
    message.classList.remove('is-error');
    message.textContent = `✓ ${email} added. Share the temporary password securely.`;
    await refreshAccessAccountsFromSheets();
  } catch (err) {
    message.textContent = err.message || 'Could not add user.';
    message.classList.add('is-error');
  }
});
document.querySelector('#access-rows').addEventListener('click', async e => {
  if (!isAdmin()) return;
  const resetBtn = e.target.closest('[data-reset-password]');
  if (resetBtn) {
    const account = accessAccounts[Number(resetBtn.dataset.resetPassword)];
    if (!account) return;
    const newPass = prompt(`New password for ${account.email}:`, '');
    if (newPass === null) return;
    if (newPass.length < 6) { alert('Password must be at least 6 characters.'); return; }
    try {
      await sheetsPost('resetPassword', { email: account.email, password: newPass });
      recordActivity(`Password reset for ${account.email}`, 'User access');
      showToast(`Password updated for ${account.email}`);
      await refreshAccessAccountsFromSheets();
    } catch (err) { showErrorToast('Password reset failed: ' + err.message); }
    return;
  }
  const removeBtn = e.target.closest('[data-remove-access]');
  if (removeBtn) {
    const account = accessAccounts[Number(removeBtn.dataset.removeAccess)];
    if (!account) return;
    if (account.email === DEFAULT_ADMIN_EMAIL) { alert('The primary admin cannot be removed.'); return; }
    const ok = await showConfirm({ title: 'Remove this user?', description: 'They will no longer be able to sign in.', detail: `<div class="confirm-detail-row"><span>Email</span><strong>${escapeHtml(account.email)}</strong></div>`, variant: 'danger', confirmLabel: 'Remove user' });
    if (!ok) return;
    try {
      await sheetsPost('removeUser', { email: account.email });
      recordActivity(`Removed ${account.email}`, 'User access');
      showToast('User removed');
      await refreshAccessAccountsFromSheets();
    } catch (err) { showErrorToast('Could not remove user: ' + err.message); }
  }
});

/* ============ PROFILE ============ */
function renderProfileCard() {
  if (!currentUser) return;
  const avatar = document.querySelector('#profile-card-avatar');
  if (!avatar) return;
  if (currentUser.picture) avatar.innerHTML = `<img src="${escapeHtml(currentUser.picture)}" alt="" />`;
  else { avatar.textContent = (currentUser.name || currentUser.email).split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase(); }
  document.querySelector('#profile-card-name').textContent = currentUser.name || currentUser.email;
  document.querySelector('#profile-card-email').textContent = currentUser.email;
  document.querySelector('#profile-role') && (document.querySelector('#profile-role').value = currentUser.role || 'Viewer');
}
document.querySelector('#profile-save')?.addEventListener('click', async () => {
  if (!currentUser) return;
  const message = document.querySelector('#profile-message');
  message.classList.remove('is-error');
  const curPass = document.querySelector('#profile-current-pass').value;
  const newPass = document.querySelector('#profile-new-pass').value;
  const confPass = document.querySelector('#profile-confirm-pass').value;
  if (curPass || newPass || confPass) {
    if (newPass.length < 6) { message.textContent = 'New password must be at least 6 characters.'; message.classList.add('is-error'); return; }
    if (newPass !== confPass) { message.textContent = 'New passwords do not match.'; message.classList.add('is-error'); return; }
    try { await sheetsPost('login', { email: currentUser.email, password: curPass }); }
    catch { message.textContent = 'Current password is incorrect.'; message.classList.add('is-error'); return; }
    try {
      await sheetsPost('resetPassword', { email: currentUser.email, password: newPass });
      document.querySelector('#profile-current-pass').value = '';
      document.querySelector('#profile-new-pass').value = '';
      document.querySelector('#profile-confirm-pass').value = '';
      message.textContent = '✓ Profile updated successfully.';
      flashAutoSave('Profile saved'); showToast('Profile updated');
    } catch (err) { message.textContent = 'Failed: ' + err.message; message.classList.add('is-error'); }
  } else { message.textContent = '✓ No changes to save.'; }
});
document.querySelector('#profile-signout').addEventListener('click', () => { settingsDialog.close(); signOut(); });

/* ============ BULK DIALOGS ============ */
const bulkStatusDialog = document.querySelector('#bulk-status-dialog');
const bulkStatusOptions = document.querySelector('#bulk-status-options');
const bulkStatusApply = document.querySelector('#bulk-status-apply');
const bulkStatusCancel = document.querySelector('#bulk-status-cancel');
const bulkStatusCount = document.querySelector('#bulk-status-count');

function openBulkStatusDialog(ids) {
  if (!bulkStatusDialog) return;
  bulkStatusOptions.querySelectorAll('input[type="radio"]').forEach(r => { r.checked = false; });
  bulkStatusOptions.querySelectorAll('.bulk-status-option').forEach(el => el.classList.remove('is-selected'));
  bulkStatusApply.disabled = true;
  if (bulkStatusCount) bulkStatusCount.textContent = String(ids.length);
  bulkStatusDialog.dataset.pendingIds = JSON.stringify(ids);
  bulkStatusDialog.showModal();
  if (window.lucide) window.lucide.createIcons();
}
if (bulkStatusOptions) bulkStatusOptions.addEventListener('change', e => {
  const radio = e.target.closest('input[type="radio"]');
  if (!radio) return;
  bulkStatusOptions.querySelectorAll('.bulk-status-option').forEach(el => el.classList.remove('is-selected'));
  radio.closest('.bulk-status-option').classList.add('is-selected');
  bulkStatusApply.disabled = false;
});
if (bulkStatusCancel) bulkStatusCancel.addEventListener('click', () => bulkStatusDialog.close());
if (bulkStatusApply) bulkStatusApply.addEventListener('click', async () => {
  const checked = bulkStatusOptions.querySelector('input[type="radio"]:checked');
  if (!checked) return;
  const newStatus = checked.value;
  const ids = JSON.parse(bulkStatusDialog.dataset.pendingIds || '[]');
  if (ids.length === 0) return;
  bulkStatusDialog.close();
  const updated = [];
  for (const id of ids) { const i = vehicles.findIndex(v => v.id === id); if (i < 0) continue; vehicles[i].fleetStatus = newStatus; updated.push(vehicles[i]); }
  recordActivity(`Set fleet status to "${newStatus}" for ${updated.length} vehicle${updated.length === 1 ? '' : 's'}`, 'Vehicles');
  invalidateCache(); window.VehiclesView?.clearBulkSelection?.(); render();
  try {
    for (const v of updated) await sheetsMutate('update', { vehicle: v });
    showToast(`${updated.length} vehicle${updated.length === 1 ? '' : 's'} → ${newStatus}`);
  } catch (err) {
    showErrorToast('Bulk status update failed: ' + (err.message || 'Unknown error'));
    vehicles = await loadVehiclesFromSheets({ force: true }); render();
  }
});

const bulkCustomerDialog = document.querySelector('#bulk-customer-dialog');
const bulkCustomerInput = document.querySelector('#bulk-customer-input');
const bulkCustomerChips = document.querySelector('#bulk-customer-chips');
const bulkCustomerSuggestions = document.querySelector('#bulk-customer-suggestions');
const bulkCustomerApply = document.querySelector('#bulk-customer-apply');
const bulkCustomerCancel = document.querySelector('#bulk-customer-cancel');

function updateBulkCustomerApplyState() { if (bulkCustomerApply && bulkCustomerInput) bulkCustomerApply.disabled = bulkCustomerInput.value.trim().length === 0; }
function renderBulkCustomerSuggestions() {
  if (!bulkCustomerChips || !bulkCustomerSuggestions) return;
  const existing = [...new Set(vehicles.map(v => v.customer).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (existing.length === 0) { bulkCustomerSuggestions.hidden = true; bulkCustomerChips.innerHTML = ''; return; }
  bulkCustomerSuggestions.hidden = false;
  bulkCustomerChips.innerHTML = existing.map(n => `<button type="button" class="bulk-customer-chip" data-customer="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
}
function openBulkCustomerDialog(ids) {
  if (!bulkCustomerDialog) return;
  document.querySelector('#bulk-customer-count').textContent = String(ids.length);
  document.querySelector('#bulk-customer-count-plural').textContent = ids.length === 1 ? '' : 's';
  document.querySelector('#bulk-customer-apply-count').textContent = String(ids.length);
  bulkCustomerInput.value = '';
  updateBulkCustomerApplyState(); renderBulkCustomerSuggestions();
  bulkCustomerDialog.dataset.pendingIds = JSON.stringify(ids);
  bulkCustomerDialog.showModal();
  if (window.lucide) window.lucide.createIcons();
  requestAnimationFrame(() => bulkCustomerInput.focus());
}
if (bulkCustomerChips) bulkCustomerChips.addEventListener('click', e => {
  const chip = e.target.closest('[data-customer]');
  if (!chip) return;
  bulkCustomerInput.value = chip.dataset.customer;
  bulkCustomerInput.focus();
  bulkCustomerInput.setSelectionRange(bulkCustomerInput.value.length, bulkCustomerInput.value.length);
  updateBulkCustomerApplyState();
});
if (bulkCustomerInput) {
  bulkCustomerInput.addEventListener('input', updateBulkCustomerApplyState);
  bulkCustomerInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !bulkCustomerApply.disabled) { e.preventDefault(); bulkCustomerApply.click(); } });
}
if (bulkCustomerCancel) bulkCustomerCancel.addEventListener('click', () => bulkCustomerDialog.close());
if (bulkCustomerApply) bulkCustomerApply.addEventListener('click', async () => {
  const trimmed = bulkCustomerInput.value.trim();
  if (!trimmed) return;
  const ids = JSON.parse(bulkCustomerDialog.dataset.pendingIds || '[]');
  if (ids.length === 0) return;
  bulkCustomerDialog.close();
  const updated = [];
  for (const id of ids) { const i = vehicles.findIndex(v => v.id === id); if (i < 0) continue; vehicles[i].customer = trimmed; updated.push(vehicles[i]); }
  recordActivity(`Updated fleet customer for ${updated.length} vehicle${updated.length === 1 ? '' : 's'}`, 'Vehicles');
  invalidateCache(); window.VehiclesView?.clearBulkSelection?.(); render();
  try {
    for (const v of updated) await sheetsMutate('update', { vehicle: v });
    showToast(`${updated.length} vehicle${updated.length === 1 ? '' : 's'} → ${trimmed}`);
  } catch (err) {
    showErrorToast('Bulk customer update failed: ' + (err.message || 'Unknown error'));
    vehicles = await loadVehiclesFromSheets({ force: true }); render();
  }
});

async function bulkDeleteVehicles(ids) {
  if (ids.length === 0) return;
  const ok = await showConfirm({ title: `Delete ${ids.length} vehicle${ids.length === 1 ? '' : 's'}?`, description: 'They will be moved to Trash and can be restored from Settings.', variant: 'danger', confirmLabel: 'Delete' });
  if (!ok) return;
  const victims = vehicles.filter(v => ids.includes(v.id));
  vehicles = vehicles.filter(v => !ids.includes(v.id));
  recordActivity(`Deleted ${victims.length} vehicle${victims.length === 1 ? '' : 's'}`, 'Vehicles');
  invalidateCache(); window.VehiclesView?.clearBulkSelection?.(); render();
  try {
    for (const v of victims) await sheetsMutate('delete', { id: v.id });
    showToast(`${victims.length} vehicle${victims.length === 1 ? '' : 's'} moved to Trash`);
  } catch (err) {
    showErrorToast('Bulk delete failed: ' + (err.message || 'Unknown error'));
    vehicles = await loadVehiclesFromSheets({ force: true }); render();
  }
}

/* ============ ALERTS POPOVER / ACTIVITY DRAWER ============ */
const alertsButton = document.querySelector('#notification-button');
const alertsPopover = document.querySelector('#alerts-popover');
if (alertsButton && alertsPopover) {
  alertsButton.addEventListener('click', e => {
    e.stopPropagation();
    renderOperationalAlerts();
    alertsPopover.hidden = !alertsPopover.hidden;
    alertsButton.setAttribute('aria-expanded', String(!alertsPopover.hidden));
  });
  alertsPopover.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', e => {
    if (!e.target.closest('.alerts-control')) { alertsPopover.hidden = true; alertsButton.setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !alertsPopover.hidden) { alertsPopover.hidden = true; alertsButton.setAttribute('aria-expanded', 'false'); alertsButton.focus(); }
  });
  document.querySelector('#alerts-view-schedule').addEventListener('click', () => {
    alertsPopover.hidden = true; alertsButton.setAttribute('aria-expanded', 'false');
    setActiveView('service');
  });
  document.querySelector('#operational-alert-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-alert-vehicle]');
    if (!btn) return;
    alertsPopover.hidden = true; alertsButton.setAttribute('aria-expanded', 'false');
    setActiveView('vehicles');
    if (window.VehiclesView?.focusVehicle) window.VehiclesView.focusVehicle(btn.dataset.alertVehicle);
  });
}
const activityDialog = document.querySelector('#activity-dialog');
document.querySelector('#activity-jump').addEventListener('click', () => {
  renderActivityFeed();
  activityDialog.showModal();
  if (window.lucide) window.lucide.createIcons();
});
document.querySelector('.activity-close').addEventListener('click', () => activityDialog.close());
activityDialog.addEventListener('click', e => { if (e.target === activityDialog) activityDialog.close(); });

/* ============ BOOT ============ */
document.addEventListener('DOMContentLoaded', async () => {
  window.Sidebar?.init({
    onNavigate: (view) => setActiveView(view),
    onSettings: () => openSettings(),
    onSignOut: () => signOut()
  });

  window.OverviewView?.init({
  getVehicles: () => vehicles,
  getHistory: () => historyData,
  getServiceLog: () => serviceLog
});

  window.VehiclesView?.init({
    getVehicles: () => vehicles,
    getFilteredVehicles: () => filteredVehicles,
    setFilteredVehicles: (f) => { filteredVehicles = f; },
    getServiceLog: () => serviceLog,
    getVehiclePmStatus: (v) => vehiclePmStatus(v),
    openDrawer: (v) => openVehicleDrawer(v),
    confirm: (opts) => showConfirm(opts),
    toast: (msg) => showToast(msg),
    toastError: (msg) => showErrorToast(msg),
    recordActivity: (msg, cat) => recordActivity(msg, cat),
    invalidateCache: () => invalidateCache(),
    loadVehiclesFromSheets: (opts) => loadVehiclesFromSheets(opts),
    renderAll: () => render(),
    getActiveView: () => activeView,
    getCurrentUser: () => currentUser,
    getSortState: () => sortState,
    setSortState: (s) => { sortState = s; saveSortState(); },
    openBulkStatus: (ids) => openBulkStatusDialog(ids),
    openBulkCustomer: (ids) => openBulkCustomerDialog(ids),
    bulkDelete: (ids, done) => bulkDeleteVehicles(ids).then(done)
  });

  window.ServiceView?.init({
    getVehicles: () => vehicles,
    getServiceLog: () => serviceLog,
    openServiceDialog: (v) => openServiceDialog(v),
    confirm: (opts) => showConfirm(opts),
    toast: (msg) => showToast(msg),
    toastError: (msg) => showErrorToast(msg),
    recordActivity: (msg, cat) => recordActivity(msg, cat),
    invalidateCache: () => invalidateCache(),
    writeCache: (data) => writeCache(data),
    sheetsMutate: (action, payload) => sheetsMutate(action, payload),
    loadVehiclesFromSheets: (opts) => loadVehiclesFromSheets(opts),
    loadHistory: () => loadHistory(),
    renderAll: () => render(),
    getActiveView: () => activeView,
    getCurrentUser: () => currentUser
  });

  accessAccounts = loadAccessAccounts();
  recentActivity = loadRecentActivity();
  currentUser = loadUser();
  loadPartsList();
  applyPrefs();
  initLogin();

  try {
    vehicles = await loadVehiclesFromSheets();
    await loadHistory();
    await loadServiceLog();
  } catch (err) { console.error("Initialization data load failed", err); }

  restoreChecklistState();
  initChecklistControls();
  document.querySelector('#data-error-retry')?.addEventListener('click', retryFleetLoad);
  const bootLoader = document.querySelector('#boot-loader');
  if (typeof initCalendar === 'function') initCalendar();

  if (currentUser) {
    showApp();
    document.querySelector('#add-vehicle').hidden = true;
    if (bootLoader) bootLoader.classList.add('hidden');
  } else {
    const loginGate = document.querySelector('#login-gate');
    if (loginGate) loginGate.classList.remove('hidden');
    setTimeout(() => { if (bootLoader) bootLoader.classList.add('hidden'); }, 100);
  }
});

/* Ripple + nav glow + table shadow + alert pulse */
document.querySelectorAll('.button-primary, .button-success, .button-danger').forEach(btn => {
  btn.addEventListener('pointerdown', e => {
    const rect = btn.getBoundingClientRect();
    btn.style.setProperty('--ripple-x', `${((e.clientX - rect.left) / rect.width) * 100}%`);
    btn.style.setProperty('--ripple-y', `${((e.clientY - rect.top) / rect.height) * 100}%`);
  });
});
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('pointermove', e => {
    const rect = link.getBoundingClientRect();
    link.style.setProperty('--mouse-x', `${((e.clientX - rect.left) / rect.width) * 100}%`);
    link.style.setProperty('--mouse-y', `${((e.clientY - rect.top) / rect.height) * 100}%`);
  });
});
document.querySelectorAll('.table-scroll, .service-table-scroll').forEach(c => {
  c.addEventListener('scroll', () => c.classList.toggle('is-scrolled', c.scrollTop > 0), { passive: true });
});
function updateAlertPulse() {
  const el = document.querySelector('#notification-count');
  if (!el) return;
  el.classList.toggle('has-alerts', parseInt(el.textContent) > 0);
}
document.querySelector('#job-order-dialog')?.addEventListener('input', (e) => {
  if (e.target.classList.contains('part-code-input')) {
    const code = e.target.value.trim();
    const part = partsCache.find(p => p.itemCode === code);
    const descInput = e.target.closest('tr').querySelector('.part-desc-input');
    if (part) descInput.value = part.description;
    else descInput.value = '';
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    if (typeof showToast === 'function') {
      showToast('Printing is disabled. Please use the Print buttons inside the specific forms.');
    }
  }
});
