/* ============================================================
   FLEETLINE · sidebar.js
   Owns sidebar collapse state, nav wiring, and badge counts.
   Exposes: window.Sidebar
   ============================================================ */

(function () {
  'use strict';

  const SIDEBAR_KEY = 'fleetline-sidebar-collapsed-v1';

  let collapsed = false;
  let deps = {
    onNavigate: null,
    onSettings: null,
    onSignOut: null
  };

  /* ---------- STATE ---------- */
  function loadState() {
    collapsed = localStorage.getItem(SIDEBAR_KEY) === 'true';
    document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  }

  function toggle() {
    collapsed = !collapsed;
    localStorage.setItem(SIDEBAR_KEY, String(collapsed));
    document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
    if (window.lucide) window.lucide.createIcons();
  }

  /* ---------- BADGE COUNTS ---------- */
  function updateCounts(counts = {}) {
    const { vehicle, service, calendar, serviceTitle, calendarTitle } = counts;

    const vEl = document.querySelector('#nav-vehicle-count');
    if (vEl && typeof vehicle === 'number') {
      vEl.textContent = String(vehicle).padStart(2, '0');
    }

    const sEl = document.querySelector('#nav-service-count');
    if (sEl && typeof service === 'number') {
      if (service === 0) {
        sEl.hidden = true;
      } else {
        sEl.hidden = false;
        sEl.textContent = String(service);
        sEl.title = serviceTitle || `${service} service item${service === 1 ? '' : 's'}`;
      }
    }

    const cEl = document.querySelector('#nav-calendar-count');
    if (cEl && typeof calendar === 'number') {
      if (calendar === 0) {
        cEl.hidden = true;
      } else {
        cEl.hidden = false;
        cEl.textContent = String(calendar);
        cEl.title = calendarTitle || `${calendar} vehicle${calendar === 1 ? '' : 's'} due this month`;
      }
    }
  }

  /* ---------- ACTIVE NAV HIGHLIGHT ---------- */
  function setActive(view) {
    document.querySelectorAll('.nav-link[data-view]').forEach(link => {
      link.classList.toggle('active', link.dataset.view === view);
    });
  }

  /* ---------- INIT ---------- */
  function init(options = {}) {
    deps = { ...deps, ...options };
    loadState();

    const collapseBtn = document.querySelector('#sidebar-collapse');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', toggle);
    }

    document.querySelectorAll('.nav-link[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.add('pulse');
        setTimeout(() => btn.classList.remove('pulse'), 550);
        if (typeof deps.onNavigate === 'function') {
          deps.onNavigate(btn.dataset.view);
        }
      });
    });

    const settingsBtn = document.querySelector('#settings-nav');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        if (typeof deps.onSettings === 'function') deps.onSettings();
      });
    }

    const logoutBtn = document.querySelector('#logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (typeof deps.onSignOut === 'function') deps.onSignOut();
      });
    }

    if (window.lucide) window.lucide.createIcons();
  }

  /* ---------- PUBLIC API ---------- */
  window.Sidebar = {
    init,
    toggle,
    setActive,
    updateCounts
  };
})();