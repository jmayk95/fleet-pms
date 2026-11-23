/* ============================================================
   FLEETLINE · overview.js (v6 — Updated Activity List layout)
   ============================================================ */
(function () {
  let ctx = null;
  let charts = {};

  function init(options) {
    ctx = options || {};
  }

  /* ---------- Aggregation helpers ---------- */

  function bucketOf(v) {
    const prefs = window.FleetlinePrefs || {};
    const logic = prefs.serviceLogic || 'both';
    const threshold = Number(v.threshold) || 0;
    const odo = Number(v.odometer) || 0;
    const next = String(v.nextMilestone || '').trim();
    if (v.fleetStatus === 'Retired') return 'retired';
    if (next.toLowerCase() === 'all complete' || threshold === 0) return 'complete';

    const km = threshold - odo;
    let days = null;
    if (v.dueDate) {
      const m = String(v.dueDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        const today = new Date(); today.setHours(0, 0, 0, 0);
        days = Math.round((due - today) / 86400000);
      }
    }
    const overdueFlag = (logic === 'days') ? (days !== null && days < 0)
                      : (logic === 'km')   ? (km < 0)
                      : ((days !== null && days < 0) || km < 0);
    if (overdueFlag) return 'overdue';
    const soonFlag = (logic === 'days') ? (days !== null && days >= 0 && days <= 15)
                    : (logic === 'km')   ? (km >= 0 && km <= 200)
                    : ((days !== null && days >= 0 && days <= 15) || (km >= 0 && km <= 200));
    if (soonFlag) return 'due-soon';
    return 'on-track';
  }

  function fleetHealthScore(vehicles) {
    if (!vehicles.length) return 0;
    const active = vehicles.filter(v => v.fleetStatus !== 'Retired');
    if (!active.length) return 100;
    let score = 0;
    active.forEach(v => {
      const b = bucketOf(v);
      if (b === 'complete' || b === 'on-track') score += 100;
      else if (b === 'due-soon') score += 60;
      else if (b === 'overdue') score += 20;
    });
    return Math.round(score / active.length);
  }

  function healthStatus(score) {
    if (score >= 85) return { label: 'Excellent', tone: 'green' };
    if (score >= 70) return { label: 'Healthy', tone: 'green' };
    if (score >= 50) return { label: 'Needs attention', tone: 'amber' };
    return { label: 'Critical', tone: 'red' };
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const m = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (isNaN(d.getTime())) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000);
  }

  function formatNum(n) {
    if (n === '' || n === null || n === undefined) return '—';
    return Number(n).toLocaleString('en-US');
  }

  function buildSparkline(history, field) {
    if (!Array.isArray(history) || !history.length) return [];
    const sorted = history.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return sorted.slice(-30).map(h => Number(h[field]) || 0);
  }

  /* ---------- Renderers ---------- */

  function renderMetrics(vehicles) {
    const active = vehicles.filter(v => v.fleetStatus !== 'Retired');
    const total = vehicles.length;
    const overdue = active.filter(v => bucketOf(v) === 'overdue').length;
    const dueSoon = active.filter(v => bucketOf(v) === 'due-soon').length;

    const score = fleetHealthScore(vehicles);
    const status = healthStatus(score);

    const scoreEl = document.querySelector('#health-score-value');
    if (scoreEl) scoreEl.textContent = String(score);
    const statusEl = document.querySelector('#health-score-status');
    if (statusEl) { statusEl.textContent = status.label; statusEl.dataset.tone = status.tone; }
    const ring = document.querySelector('#health-ring-bar');
    if (ring) {
      const r = 18, circ = 2 * Math.PI * r;
      ring.style.strokeDasharray = String(circ);
      ring.style.strokeDashoffset = String(circ - (score / 100) * circ);
      ring.dataset.tone = status.tone;
    }

    setText('#metric-total', formatNum(total));
    setText('#metric-overdue', formatNum(overdue));
    setText('#metric-upcoming', formatNum(dueSoon));

    const hist = ctx.getHistory ? ctx.getHistory() : [];
    const sortedHist = Array.isArray(hist)
      ? hist.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
      : [];
    const latest = sortedHist[sortedHist.length - 1];
    const prev = sortedHist[sortedHist.length - 2];
    if (latest && prev) {
      setDelta('#delta-total', Number(latest.total) - Number(prev.total));
      setDelta('#delta-overdue', Number(latest.overdue) - Number(prev.overdue), true);
      setDelta('#delta-upcoming', Number(latest.dueSoon) - Number(prev.dueSoon), true);
    }

    const overdueCard = document.querySelector('.metric-overdue');
    if (overdueCard) overdueCard.dataset.hasAlert = String(overdue > 0);

    drawSparkline('spark-total', buildSparkline(hist, 'total'));
    drawSparkline('spark-overdue', buildSparkline(hist, 'overdue'));
    drawSparkline('spark-upcoming', buildSparkline(hist, 'dueSoon'));
  }

  function setText(sel, txt) { const el = document.querySelector(sel); if (el) el.textContent = txt; }

  function setDelta(sel, diff, invertGood) {
    const el = document.querySelector(sel);
    if (!el) return;
    const n = Number(diff) || 0;
    const arrow = n > 0 ? '↑' : n < 0 ? '↓' : '—';
    el.textContent = `${arrow} ${Math.abs(n)}`;
    el.classList.remove('delta-up', 'delta-down', 'delta-flat');
    if (n === 0) el.classList.add('delta-flat');
    else if ((n > 0) !== !!invertGood) el.classList.add('delta-up');
    else el.classList.add('delta-down');
  }

  function drawSparkline(canvasId, values) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (!values || values.length < 2) { canvas.style.display = 'none'; return; }
    canvas.style.display = 'block';
    try { charts[canvasId]?.destroy(); } catch (e) {}
    charts[canvasId] = new Chart(canvas, {
      type: 'line',
      data: {
        labels: values.map((_, i) => i),
        datasets: [{
          data: values,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.35,
          fill: true,
          backgroundColor: 'rgba(79, 145, 247, 0.12)',
          borderColor: 'rgba(79, 145, 247, 0.85)'
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } }
      }
    });
  }

  function renderStatusMix(vehicles) {
    const counts = { complete: 0, 'on-track': 0, 'due-soon': 0, overdue: 0 };
    vehicles.forEach(v => {
      if (v.fleetStatus === 'Retired') return;
      const b = bucketOf(v);
      if (counts[b] !== undefined) counts[b]++;
    });

    const canvas = document.getElementById('service-status-chart');
    if (!canvas) return;
    try { charts.statusMix?.destroy(); } catch (e) {}

    const total = counts.complete + counts['on-track'] + counts['due-soon'] + counts.overdue;
    const centerVal = document.getElementById('pie-center-value');
    const centerCap = document.getElementById('pie-center-caption');
    if (centerVal) centerVal.textContent = formatNum(total);
    if (centerCap) centerCap.textContent = 'vehicles';

    charts.statusMix = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: ['Complete', 'On Track', 'Due Soon', 'Overdue'],
        datasets: [{
          data: [counts.complete, counts['on-track'], counts['due-soon'], counts.overdue],
          backgroundColor: ['#4a9c6c', '#0084c9', '#f38020', '#e42926'],
          borderWidth: 0,
          hoverOffset: 4
        }]
      },
      options: {
        cutout: '68%',
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, padding: 12, font: { size: 11 } } } }
      }
    });
  }

  function renderAttentionList(vehicles) {
    const list = document.getElementById('attention-list');
    if (!list) return;

    const attention = vehicles
      .filter(v => v.fleetStatus !== 'Retired' && bucketOf(v) === 'overdue')
      .map(v => {
        const km = Number(v.threshold) - Number(v.odometer);
        const days = daysUntil(v.dueDate);
        return { v, km, days, severity: Math.min(km, days !== null ? days : 0) };
      })
      .sort((a, b) => a.severity - b.severity)
      .slice(0, 5);

    if (!attention.length) {
      list.innerHTML = '<li class="attention-empty"><i data-lucide="check-circle-2"></i> No overdue vehicles — nice work!</li>';
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    list.innerHTML = attention.map(({ v, days }) => {
      const badges = [];
      
      // Only show Days Overdue Badge
      if (days !== null && days < 0) {
        const daysOver = Math.abs(days);
        const dayLabel = daysOver === 1 ? 'day' : 'days';
        badges.push(`<span class="attention-badge is-red">${daysOver} ${dayLabel} overdue</span>`);
      } else {
        // Fallback if days is null but it's overdue by km
        badges.push(`<span class="attention-badge is-red">Overdue</span>`);
      }

      // Due Target String
      const targetStr = `${v.nextMilestone || 'Service'} · ${formatNum(v.threshold)} km`;

      return `<li><button class="attention-row" type="button" data-vehicle-id="${v.id}">
        <span class="attention-dot"></span>
        
        <div class="attention-main-single">
          <span class="attention-customer">${v.customer || 'Unknown'}</span>
          <strong class="attention-plate">${v.plate || v.model || '—'}</strong>
          <span class="attention-target">Due at ${targetStr}</span>
        </div>

        <div class="attention-badges">
          ${badges.join('')}
        </div>
      </button></li>`;
    }).join('');

    if (window.lucide) window.lucide.createIcons();
    list.querySelectorAll('.attention-row').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = vehicles.find(x => x.id === btn.dataset.vehicleId);
        if (v && window.Fleetline?.openVehicleDrawer) window.Fleetline.openVehicleDrawer(v);
      });
    });
  }

  function renderRecentActivity(serviceLog) {
    const list = document.getElementById('recent-activity-list');
    if (!list) return;

    const recent = (Array.isArray(serviceLog) ? serviceLog : [])
      .slice()
      .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0))
      .slice(0, 8);

    if (!recent.length) {
      list.innerHTML = '<li class="attention-empty"><i data-lucide="inbox"></i> No services logged yet.</li>';
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    list.innerHTML = recent.map(e => {
      const when = e.completedAt ? new Date(e.completedAt) : null;
      const ago = when ? timeAgo(when) : '—';
      const milestone = e.milestone || 'Service';
      const odoStr = e.odometer !== '' && e.odometer != null ? `${formatNum(e.odometer)} km` : '';
      
      // Added Customer before Plate
      return `<li class="activity-row">
        <span class="activity-dot"></span>
        <div class="activity-main-single">
          <span class="activity-customer">${e.customer || 'Unknown'}</span>
          <strong class="activity-plate">${e.plate || e.model || '—'}</strong>
          <span class="activity-desc">${milestone} completed ${odoStr ? 'at ' + odoStr : ''}</span>
        </div>
        <span class="activity-when">${ago}</span>
      </li>`;
    }).join('');
    if (window.lucide) window.lucide.createIcons();
  }

  function timeAgo(d) {
    const ms = Date.now() - d.getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }

  function renderTrendChart(history) {
    const canvas = document.getElementById('fleet-trend-chart');
    if (!canvas) return;
    try { charts.trend?.destroy(); } catch (e) {}

    const sorted = (Array.isArray(history) ? history : [])
      .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-30);

    if (sorted.length < 2) {
      canvas.parentElement.innerHTML = '<div class="chart-empty">Not enough history yet — check back in a few days.</div>';
      return;
    }

    charts.trend = new Chart(canvas, {
      type: 'line',
      data: {
        labels: sorted.map(h => String(h.date).slice(5)),
        datasets: [
          {
            label: 'Overdue',
            data: sorted.map(h => Number(h.overdue) || 0),
            borderColor: '#e42926',
            backgroundColor: 'rgba(228, 41, 38, 0.08)',
            tension: 0.35,
            fill: true,
            pointRadius: 2,
            pointHoverRadius: 4
          },
          {
            label: 'Due Soon',
            data: sorted.map(h => Number(h.dueSoon) || 0),
            borderColor: '#f38020',
            backgroundColor: 'rgba(243, 128, 32, 0.08)',
            tension: 0.35,
            fill: true,
            pointRadius: 2,
            pointHoverRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, padding: 12, font: { size: 11 } } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } }
        }
      }
    });
  }

  /* ---------- Main render ---------- */

  function render() {
    if (!ctx || !ctx.getVehicles) return;
    const vehicles = ctx.getVehicles() || [];
    const history = ctx.getHistory ? ctx.getHistory() : [];
    const serviceLog = ctx.getServiceLog ? ctx.getServiceLog() : [];

    renderMetrics(vehicles);
    renderStatusMix(vehicles);
    renderAttentionList(vehicles);
    renderRecentActivity(serviceLog);
    renderTrendChart(history);

    if (window.lucide) window.lucide.createIcons();
  }

  window.OverviewView = { init, render };
})();