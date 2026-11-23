/* ============================================================
   FLEETLINE · fleet-utils.js
   Shared constants + pure helpers used by every view, the
   drawer, the dialogs, the sidebar, and calendar.js.
   Exposes: window.FleetUtils
   No DOM queries here — pure data/format helpers only.
   ============================================================ */

(function () {
  'use strict';

  /* ---------- Constants ---------- */
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

  const PMS_NEAR_DUE_KM = 200;
  const PMS_NEAR_DUE_DAYS = 15;

  const VIN_LENGTH = 17;
  const PLATE_LENGTH = 6;
  const VIN_REGEX = /^[A-Z0-9]{17}$/;
  const PLATE_REGEX = /^[A-Z0-9]{6}$/;

  /* ---------- Numbers ---------- */
  function safeNum(v) {
    if (v === null || v === undefined || v === '') return 0;
    const cleaned = String(v).replace(/[^\d.-]/g, '');
    const n = Number(cleaned);
    return isNaN(n) ? 0 : n;
  }

  function formatNumber(n) {
    if (n === '' || n === null || n === undefined) return '—';
    return safeNum(n).toLocaleString('en-US');
  }

  /* ---------- VIN / plate ---------- */
  function normalizeVin(v) { return String(v ?? '').trim().toUpperCase(); }
  function normalizePlate(v) { return String(v ?? '').trim().toUpperCase(); }

  /* ---------- Dates ---------- */
  function dateInputValue(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function daysUntil(dateString) {
    if (!dateString) return 0;
    const str = String(dateString).trim();
    if (!str) return 0;
    const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return 0;
    const [, y, m, d] = match;
    const dateObj = new Date(Number(y), Number(m) - 1, Number(d));
    if (isNaN(dateObj.getTime())) return 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((dateObj - today) / 86400000);
  }

  function addMonthsToDate(dateString, months) {
    if (!dateString) return '';
    const match = String(dateString).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return '';
    const [, y, m, d] = match;
    const targetMonth = new Date(Number(y), Number(m) - 1 + months, 1);
    const targetDay = Math.min(
      Number(d),
      new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate()
    );
    return dateInputValue(new Date(targetMonth.getFullYear(), targetMonth.getMonth(), targetDay));
  }

  function getDateFormat() {
    return (window.FleetlinePrefs && window.FleetlinePrefs.dateFormat) || 'long';
  }

  function formatDate(value) {
    if (!value) return 'Not set';
    const str = String(value).trim();
    if (!str) return 'Not set';
    const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return str;
    const [, y, m, d] = match;
    const dateObj = new Date(Number(y), Number(m) - 1, Number(d));
    if (isNaN(dateObj.getTime())) return str;
    const fmt = getDateFormat();
    if (fmt === 'numeric') return `${y}-${m}-${d}`;
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(dateObj);
  }

  function formatShortDate(value) { return formatDate(value); }

  function formatDateTime(isoString) {
    if (!isoString) return '—';
    const dt = new Date(isoString);
    if (isNaN(dt.getTime())) return String(isoString);
    const fmt = getDateFormat();
    const datePart = fmt === 'numeric'
      ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
      : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(dt);
    const clock = (window.FleetlinePrefs && window.FleetlinePrefs.clockFormat) || '12h';
    const timeOpts = clock === '24h'
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { hour: '2-digit', minute: '2-digit', hour12: true };
    return `${datePart} · ${new Intl.DateTimeFormat('en-US', timeOpts).format(dt)}`;
  }

  /* ---------- Service plan ---------- */
  function getServicePlan(saleDate, lastService) {
    const idx = SERVICE_SCHEDULE.findIndex(s => s.milestone === lastService);
    const next = SERVICE_SCHEDULE[idx + 1];
    return {
      nextMilestone: next?.milestone || 'All Complete',
      threshold: next?.threshold || 0,
      dueDate: next ? addMonthsToDate(saleDate, next.months) : ''
    };
  }

  /* ---------- Service status ---------- */
  function isComplete(v) {
    return v.nextMilestone === 'All Complete' || safeNum(v.threshold) === 0;
  }

  function isOverdue(v) {
    if (isComplete(v)) return false;
    const days = daysUntil(v.dueDate);
    const km = safeNum(v.threshold) - safeNum(v.odometer);
    const logic = (window.FleetlinePrefs && window.FleetlinePrefs.serviceLogic) || 'both';
    if (logic === 'days') return days < 0;
    if (logic === 'km') return km < 0;
    return days < 0 || km < 0;
  }

  function isDueSoon(v) {
    if (isComplete(v) || isOverdue(v)) return false;
    const days = daysUntil(v.dueDate);
    const km = safeNum(v.threshold) - safeNum(v.odometer);
    const logic = (window.FleetlinePrefs && window.FleetlinePrefs.serviceLogic) || 'both';
    if (logic === 'days') return days >= 0 && days <= PMS_NEAR_DUE_DAYS;
    if (logic === 'km') return km >= 0 && km <= PMS_NEAR_DUE_KM;
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
    const days = daysUntil(v.dueDate);
    if (days >= 0 && days <= PMS_NEAR_DUE_DAYS) return 'due-soon';
    return 'on-track';
  }

  /* ---------- Strings ---------- */
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

function getVehicleImage(model, color, isProfile = false) {
  if (!model || !color) return '';

  const modelAliases = {
    'R280 Sport': 'R280'
  };

  const imageModel = modelAliases[model] || model;
  const m = String(imageModel).toLowerCase().trim().replace(/\s+/g, '-');
  const c = String(color).toLowerCase().trim().replace(/\s+/g, '-');

  return `images/${m}-${c}${isProfile ? '-profile' : ''}.png`;
}

  function vehicleThumbHtml(v, { profile = false, imgClass = 'vehicle-avatar-img', imgStyle = '' } = {}) {
    const src = getVehicleImage(v.model, v.color, profile) || '';
    const styleAttr = imgStyle ? ` style="${imgStyle}"` : '';
    return `<img src="${escapeHtml(src)}" alt="" class="${imgClass}"${styleAttr}
        onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
      <i class="fa-solid fa-motorcycle" style="display:none; font-size:20px; color:var(--primary); margin-right:8px;"></i>`;
  }

  /* ---------- Publish ---------- */
  window.FleetUtils = {
    SERVICE_SCHEDULE,
    PMS_NEAR_DUE_KM,
    PMS_NEAR_DUE_DAYS,
    VIN_LENGTH,
    PLATE_LENGTH,
    VIN_REGEX,
    PLATE_REGEX,
    safeNum,
    formatNumber,
    normalizeVin,
    normalizePlate,
    dateInputValue,
    daysUntil,
    addMonthsToDate,
    formatDate,
    formatShortDate,
    formatDateTime,
    getServicePlan,
    isComplete,
    isOverdue,
    isDueSoon,
    vehiclePmStatus,
    getServiceBucket,
    escapeHtml,
    getVehicleImage,
    vehicleThumbHtml
  };
})();