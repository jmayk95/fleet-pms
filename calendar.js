/* ============ CALENDAR MODULE ============ */
let currentCalDate = new Date();

/* In-memory cache: year -> Map<"YYYY-MM-DD", {name, type}> */
const liveHolidaysCache = new Map();
/* Track which years we've already requested to avoid redundant fetches */
const holidayFetchState = new Map(); // year -> 'loading' | 'done' | 'error'

/* ============================================================
   FALLBACK PHILIPPINE HOLIDAYS
   Used on first paint before the live data arrives.
   ============================================================ */
const PH_HOLIDAYS = {
  '01-01': { name: "New Year's Day", type: 'regular' },
  '02-25': { name: 'EDSA People Power Revolution Anniversary', type: 'special-working' },
  '04-09': { name: 'Araw ng Kagitingan', type: 'regular' },
  '05-01': { name: 'Labor Day', type: 'regular' },
  '06-12': { name: 'Independence Day', type: 'regular' },
  '08-21': { name: 'Ninoy Aquino Day', type: 'special' },
  '11-01': { name: "All Saints' Day", type: 'special' },
  '11-02': { name: "All Souls' Day", type: 'special' },
  '11-30': { name: 'Bonifacio Day', type: 'regular' },
  '12-08': { name: 'Feast of the Immaculate Conception', type: 'special' },
  '12-24': { name: 'Christmas Eve', type: 'special' },
  '12-25': { name: 'Christmas Day', type: 'regular' },
  '12-30': { name: 'Rizal Day', type: 'regular' },
  '12-31': { name: 'Last Day of the Year', type: 'special' }
};

function computeEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function lastMondayOfAugust(year) {
  const d = new Date(year, 7, 31);
  while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
  return d;
}

function getHolidaysForYear(year) {
  const map = new Map();
  Object.keys(PH_HOLIDAYS).forEach(key => {
    const [m, d] = key.split('-').map(Number);
    const iso = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    map.set(iso, PH_HOLIDAYS[key]);
  });

  const easter = computeEasterSunday(year);
  const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const maundy = new Date(easter); maundy.setDate(easter.getDate() - 3);
  const goodFri = new Date(easter); goodFri.setDate(easter.getDate() - 2);
  const blackSat = new Date(easter); blackSat.setDate(easter.getDate() - 1);
  map.set(iso(maundy), { name: 'Maundy Thursday', type: 'regular' });
  map.set(iso(goodFri), { name: 'Good Friday', type: 'regular' });
  map.set(iso(blackSat), { name: 'Black Saturday', type: 'special' });

  map.set(iso(lastMondayOfAugust(year)), { name: 'National Heroes Day', type: 'regular' });

  const CNY = { 2025: '2025-01-29', 2026: '2026-02-17', 2027: '2027-02-06', 2028: '2028-01-26', 2029: '2029-02-13', 2030: '2030-02-03' };
  if (CNY[year]) map.set(CNY[year], { name: 'Chinese New Year', type: 'special' });

  return map;
}

/* ============================================================
   LIVE FETCH — runs in background, re-renders on success
   ============================================================ */
async function fetchAndCacheHolidays(year) {
  if (holidayFetchState.get(year) === 'loading') return;
  if (holidayFetchState.get(year) === 'done') return;
  holidayFetchState.set(year, 'loading');

  try {
    // sheetsGet is defined globally in app.js
    const res = await sheetsGet(`holidays&year=${year}`);
    if (res && res.ok && res.holidays && typeof res.holidays === 'object') {
      const map = new Map(Object.entries(res.holidays));
      liveHolidaysCache.set(year, map);
      holidayFetchState.set(year, 'done');
      console.log(`[Fleetline] Loaded ${map.size} PH holidays for ${year} (source: ${res.source || 'api'})`);
      // Re-render if we're still looking at that year
      if (currentCalDate.getFullYear() === year) {
        renderCalendar(vehicles, serviceLog);
      }
    } else {
      holidayFetchState.set(year, 'error');
    }
  } catch (err) {
    console.warn(`[Fleetline] Could not fetch live holidays for ${year}:`, err);
    holidayFetchState.set(year, 'error');
  }
}

/* ============================================================
   INIT
   ============================================================ */
function initCalendar() {
  const container = document.getElementById('calendar-container');
  if (!container) return;

  container.innerHTML = `
    <div class="cal-header">
      <div class="cal-title" id="cal-month-title">Month Year</div>
      <div class="cal-legend">
        <span class="legend-item"><span class="legend-dot status-overdue"></span> Overdue</span>
        <span class="legend-item"><span class="legend-dot status-due"></span> Due Soon</span>
        <span class="legend-item"><span class="legend-dot status-track"></span> On Track</span>
        <span class="legend-item"><span class="legend-dot status-complete"></span> Completed</span>
        <span class="legend-item"><span class="legend-dot status-holiday"></span> Holiday</span>
      </div>
      <div class="cal-nav">
        <button id="cal-prev">Prev</button>
        <button id="cal-today">Today</button>
        <button id="cal-next">Next</button>
      </div>
    </div>
    <div class="cal-grid-header">
      <div class="cal-day-name">Sun</div>
      <div class="cal-day-name">Mon</div>
      <div class="cal-day-name">Tue</div>
      <div class="cal-day-name">Wed</div>
      <div class="cal-day-name">Thu</div>
      <div class="cal-day-name">Fri</div>
      <div class="cal-day-name">Sat</div>
    </div>
    <div class="cal-grid" id="cal-grid"></div>
  `;

  document.getElementById('cal-prev').addEventListener('click', () => {
    currentCalDate.setMonth(currentCalDate.getMonth() - 1);
    renderCalendar(vehicles, serviceLog);
    fetchAndCacheHolidays(currentCalDate.getFullYear());
  });

  document.getElementById('cal-next').addEventListener('click', () => {
    currentCalDate.setMonth(currentCalDate.getMonth() + 1);
    renderCalendar(vehicles, serviceLog);
    fetchAndCacheHolidays(currentCalDate.getFullYear());
  });

  document.getElementById('cal-today').addEventListener('click', () => {
    currentCalDate = new Date();
    renderCalendar(vehicles, serviceLog);
    fetchAndCacheHolidays(currentCalDate.getFullYear());
    setTimeout(() => {
      const todayCell = document.querySelector('.cal-cell.today');
      if (todayCell) todayCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  });

  // First paint with fallback data (instant)
  renderCalendar(vehicles, serviceLog);
  // Then kick off the live fetch
  fetchAndCacheHolidays(currentCalDate.getFullYear());
}

/* ============================================================
   RENDER
   ============================================================ */
function renderCalendar(vehicleList, logList) {
  const grid = document.getElementById('cal-grid');
  const title = document.getElementById('cal-month-title');
  if (!grid || !title) return;

  const year = currentCalDate.getFullYear();
  const month = currentCalDate.getMonth();

  title.textContent = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(currentCalDate);

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

  const todayObj = new Date();
  const isCurrentMonth = todayObj.getMonth() === month && todayObj.getFullYear() === year;
  const todayDate = todayObj.getDate();

  // Prefer live data if available; otherwise fall back to computed
  const holidaysMap = liveHolidaysCache.get(year) || getHolidaysForYear(year);

  let gridHtml = '';

  // 1. Empty cells for previous month
  for (let i = 0; i < firstDay; i++) {
    const prevDay = prevMonthDays - firstDay + i + 1;
    gridHtml += `<div class="cal-cell empty" style="color: var(--muted); opacity: 0.5;"><div class="cal-date" style="align-self: flex-end;">${prevDay}</div></div>`;
  }

  // 2. Days of the current month
  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = isCurrentMonth && day === todayDate;
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const holiday = holidaysMap.get(dateStr);
    const events = [];

    // A. Holiday
    if (holiday) {
      const typeLabel = holiday.type === 'regular' ? 'Regular Holiday'
        : holiday.type === 'special-working' ? 'Special (Working) Day'
        : 'Special (Non-Working)';
      events.push({
        type: 'holiday',
        id: '',
        title: `🎉 ${holiday.name}`,
        statusClass: 'status-holiday',
        statusLabel: typeLabel,
        tooltip: `${holiday.name}\n${typeLabel}`
      });
    }

    // B. Completed service logs
    if (Array.isArray(logList)) {
      logList.forEach(log => {
        if (!log.completedAt) return;
        const completedDateStr = String(log.completedAt).slice(0, 10);
        if (completedDateStr === dateStr) {
          events.push({
            type: 'log',
            id: log.vehicleId,
            title: `${log.plate || log.model} - ${log.milestone}`,
            statusClass: 'status-complete',
            statusLabel: 'Completed',
            tooltip: `PMS: ${log.pmsNumber || '—'}\nClosed by: ${log.completedBy || '—'}\nOdo: ${formatNumber(log.odometer)} km`
          });
        }
      });
    }

    // C. Upcoming due dates
    vehicleList.forEach(v => {
      if (!v.dueDate || v.fleetStatus === 'Retired') return;
      if (String(v.dueDate).trim().startsWith(dateStr)) {
        let statusClass = 'status-track';
        let statusLabel = 'On Track';
        if (isComplete(v)) { statusClass = 'status-complete'; statusLabel = 'Complete'; }
        else if (isOverdue(v)) { statusClass = 'status-overdue'; statusLabel = 'Overdue'; }
        else if (isDueSoon(v)) { statusClass = 'status-due'; statusLabel = 'Due Soon'; }

        events.push({
          type: 'vehicle',
          id: v.id,
          title: `${v.plate || v.model} - ${v.nextMilestone}`,
          statusClass: statusClass,
          statusLabel: statusLabel,
          tooltip: `Customer: ${v.customer || '—'}\nRider: ${v.rider || '—'}\nOdometer: ${formatNumber(v.odometer)} km\nRemaining: ${formatNumber(v.threshold - v.odometer)} km\nPMS Ticket: ${v.currentPmsTicket || 'Not assigned'}\nStatus: ${statusLabel}`
        });
      }
    });

    const MAX_VISIBLE = 3;
    const visibleEvents = events.slice(0, MAX_VISIBLE);
    const hiddenCount = events.length - MAX_VISIBLE;

    let eventsHtml = visibleEvents.map(e => {
      const dataAttrs = e.type === 'holiday'
        ? `data-type="holiday"`
        : `data-vehicle-id="${e.id}" data-type="${e.type}"`;
      return `<div class="cal-event ${e.statusClass}" ${dataAttrs} title="${escapeHtml(e.tooltip)}">
        ${escapeHtml(e.title)}
      </div>`;
    }).join('');

    if (hiddenCount > 0) {
      eventsHtml += `<div class="cal-event-more" style="font-size: 10px; font-weight: 700; color: var(--primary); cursor: pointer; padding: 4px; text-align: center; background: var(--primary-soft); border-radius: 4px;" title="${hiddenCount} more events on this date">
        + ${hiddenCount} more
      </div>`;
    }

    const holidayClass = holiday ? 'is-holiday' : '';
    gridHtml += `
      <div class="cal-cell ${isToday ? 'today' : ''} ${holidayClass}" data-date="${dateStr}">
        <div class="cal-date">${day}</div>
        <div class="cal-events">${eventsHtml}</div>
      </div>
    `;
  }

  // 3. Empty cells for next month
  const totalCells = firstDay + daysInMonth;
  const remainingCells = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= remainingCells; i++) {
    gridHtml += `<div class="cal-cell empty" style="color: var(--muted); opacity: 0.5;"><div class="cal-date" style="align-self: flex-end;">${i}</div></div>`;
  }

  grid.innerHTML = gridHtml;

  // Click listeners
  grid.querySelectorAll('.cal-event').forEach(el => {
    if (el.dataset.type === 'holiday') return;
    el.addEventListener('click', () => {
      const vId = el.dataset.vehicleId;
      const vehicle = vehicles.find(v => v.id === vId);
      if (vehicle) {
        if (el.dataset.type === 'log') {
          if (typeof openServiceHistoryDrawer === 'function') openServiceHistoryDrawer(vehicle);
        } else {
          if (typeof openVehicleDrawer === 'function') openVehicleDrawer(vehicle);
        }
      }
    });
  });

  if (window.lucide) window.lucide.createIcons();
}