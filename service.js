/* ============================================================
   FLEETLINE · service.js
   Service schedule queue, tabs, search, inline-edit Actual Odo,
   row click → dialog, exports, sidebar badge counts.
   Exposes: window.ServiceView
   Depends on: window.FleetUtils, window.FleetlinePrefs
   ============================================================ */

(function () {
  'use strict';

  let deps = {
    getVehicles: () => [],
    getServiceLog: () => [],
    openServiceDialog: () => {},
    confirm: () => Promise.resolve(false),
    toast: () => {},
    toastError: () => {},
    recordActivity: () => {},
    invalidateCache: () => {},
    writeCache: () => {},
    sheetsMutate: () => Promise.resolve(),
    loadVehiclesFromSheets: () => Promise.resolve([]),
    loadHistory: () => Promise.resolve(),
    renderAll: () => {},
    getActiveView: () => 'service',
    getCurrentUser: () => null
  };

  let activeServiceTab = 'all';
  let serviceSearchTerm = '';
  let serviceSearchDebounceTimer = null;

  function U() { return window.FleetUtils; }

  function formatNumber(n) { return U().formatNumber(n); }
  function formatDate(v) { return U().formatDate(v); }
  function escapeHtml(v) { return U().escapeHtml(v); }
  function getVehicleImage(m, c) { return U().getVehicleImage(m, c); }
  function isOverdue(v) { return U().isOverdue(v); }
  function isDueSoon(v) { return U().isDueSoon(v); }
  function daysUntil(d) { return U().daysUntil(d); }
  function safeNum(n) { return U().safeNum(n); }
  function getServiceBucket(v) { return U().getServiceBucket(v); }

  /* ---------- QUEUE / SORT ---------- */
  function pmsNumberToInt(pms) {
    const s = String(pms || '').trim();
    const m = s.match(/^NRD-(\d+)$/);
    if (!m) return null;
    const n = Number(m[1]);
    return isNaN(n) ? null : n;
  }

  // Single source of truth for due-status label / class / days text.
  // Returns { label, cls, daysLabel|null } — call sites must use .label / .cls / .daysLabel.
  function serviceDueStatus(v) {
    switch (getServiceBucket(v)) {
      case 'complete': return { label: 'Complete', cls: 'due-complete', daysLabel: 'Service complete' };
      case 'overdue':  return { label: 'Overdue',  cls: 'due-overdue',  daysLabel: null };
      case 'due-soon': return { label: 'Due Soon', cls: 'due-due-soon', daysLabel: null };
      default:         return { label: 'On Track', cls: 'due-upcoming', daysLabel: null };
    }
  }

  function getFilteredServiceQueue() {
    const base = vehicles.filter(v => {
      if (v.fleetStatus === 'Retired') return false;
      const b = getServiceBucket(v);
      return b === 'overdue' || b === 'due-soon';
    });
    const tabFiltered = base.filter(v => {
      if (activeServiceTab === 'all') return true;
      if (activeServiceTab === 'not-scheduled') return v.workStatus === 'Not Scheduled';
      if (activeServiceTab === 'scheduled') return v.workStatus === 'Scheduled';
      if (activeServiceTab === 'in-progress') return v.workStatus === 'In Progress';
      if (activeServiceTab === 'on-hold') return v.workStatus === 'On Hold';
      return true;
    });
    const needle = serviceSearchTerm.toLowerCase();
    const searched = !needle ? tabFiltered : tabFiltered.filter(v =>
      [v.vin, v.model, v.plate, v.customer, v.rider, v.depot, v.currentPmsTicket].some(x => String(x || '').toLowerCase().includes(needle))
    );
    return searched.sort((a, b) => {
      const aNum = pmsNumberToInt(a.currentPmsTicket);
      const bNum = pmsNumberToInt(b.currentPmsTicket);
      if (aNum !== null && bNum !== null) return aNum - bNum;
      if (aNum !== null) return -1;
      if (bNum !== null) return 1;
      return Number(isOverdue(b)) - Number(isOverdue(a)) || daysUntil(a.dueDate) - daysUntil(b.dueDate);
    });
  }

  function getServiceTabCounts() {
    const vehicles = deps.getVehicles() || [];
    const base = vehicles.filter(v => {
      if (v.fleetStatus === 'Retired') return false;
      const b = getServiceBucket(v);
      return b === 'overdue' || b === 'due-soon';
    });
    return {
      all: base.length,
      'not-scheduled': base.filter(v => v.workStatus === 'Not Scheduled').length,
      scheduled: base.filter(v => v.workStatus === 'Scheduled').length,
      'in-progress': base.filter(v => v.workStatus === 'In Progress').length,
      'on-hold': base.filter(v => v.workStatus === 'On Hold').length
    };
  }

  /* ---------- RENDER TABS ---------- */
  function renderTabs() {
    const container = document.querySelector('#service-tabs');
    if (!container) return;
    const counts = getServiceTabCounts();
    const tabs = [
      { key: 'all', label: 'All', count: counts.all },
      { key: 'not-scheduled', label: 'Not scheduled', count: counts['not-scheduled'] },
      { key: 'scheduled', label: 'Scheduled', count: counts.scheduled },
      { key: 'in-progress', label: 'In progress', count: counts['in-progress'] },
      { key: 'on-hold', label: 'On hold', count: counts['on-hold'] }
    ];
    container.innerHTML = tabs.map(t => `<button class="filter-tab ${activeServiceTab === t.key ? 'selected' : ''}" data-tab="${t.key}" type="button" role="tab">${escapeHtml(t.label)} <span>${t.count}</span></button>`).join('');
    container.querySelectorAll('.filter-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeServiceTab = btn.dataset.tab;
        renderTabs();
        renderTable();
      });
    });
  }

  /* ---------- RENDER TABLE ---------- */
  function renderTable() {
    const due = getFilteredServiceQueue();
    const rows = due.map(v => {
      const dueInfo = serviceDueStatus(v);
      const dueLabel = dueInfo.label;
      const dueClass = dueInfo.cls;
      const workClass = v.workStatus.toLowerCase().replaceAll(' ', '-');
      const days = daysUntil(v.dueDate);
      const daysLabel = dueInfo.daysLabel
        ?? (days < 0 ? `${formatNumber(Math.abs(days))} days overdue` : `${formatNumber(days)} days remaining`);
      return `<tr data-service-id="${escapeHtml(v.id)}" tabindex="0">
        <td class="pms-number" data-label="PMS">${escapeHtml(v.currentPmsTicket || '—')}</td>
        <td data-label="Vehicle"><div class="vehicle-cell">
          <img src="${getVehicleImage(v.model, v.color)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" class="vehicle-avatar-img" />
          <i class="fa-solid fa-motorcycle" style="display:none; font-size:20px; color:var(--primary); margin-right:8px;"></i>
          <span class="vehicle-primary"><strong>${escapeHtml(v.model)}</strong><span>${escapeHtml(v.color)}</span></span>
        </div></td>
        <td data-label="Customer"><div class="vehicle-primary"><strong>${escapeHtml(v.customer)}</strong><span>${escapeHtml(v.depot || '—')}</span></div></td>
        <td data-label="Rider">
          <div class="vehicle-primary">
            <strong>${escapeHtml(v.rider || '—')}</strong>
            <span class="td-vin">${escapeHtml(v.vin || '—')}</span>
          </div>
        </td>
        <td data-label="Odometer">${formatNumber(v.odometer)} km</td>
        <td data-label="Current service">${escapeHtml(v.lastService || 'No service yet')}</td>
        <td data-label="Due status"><span class="schedule-chip ${dueClass}">${dueLabel}</span><div class="service-due-details">${daysLabel}</div></td>
        <td data-label="Work status"><span class="schedule-chip work-${workClass}">${escapeHtml(v.workStatus)}</span></td>
        <td data-label="Scheduled">${v.scheduledDate ? formatDate(v.scheduledDate) : '—'}</td>
        <td data-label="Actual odo" class="inline-edit-cell" data-edit-odo="${escapeHtml(v.id)}">${v.actualOdo === '' ? '—' : `${formatNumber(v.actualOdo)} km`}</td>
        <td class="schedule-notes-cell" data-label="Notes" title="${escapeHtml(v.notes)}">${escapeHtml(v.notes || '—')}</td>
      </tr>`;
    });
    const countEl = document.querySelector('#service-count');
    const summaryEl = document.querySelector('#service-summary');
    if (countEl) countEl.textContent = due.length;
    if (summaryEl) summaryEl.textContent = `${due.length} ${due.length === 1 ? 'record' : 'records'}`;
    const rowsEl = document.querySelector('#service-rows');
    if (rowsEl) rowsEl.innerHTML = rows.join('');
    const empty = document.querySelector('#service-empty');
    if (empty) {
      empty.hidden = rows.length > 0;
      if (due.length === 0) empty.innerHTML = `🎉 All caught up — no vehicles are due in the next ${U().PMS_NEAR_DUE_DAYS} days.`;
      else if (rows.length === 0) empty.innerHTML = `No service records match your search or filters.`;
    }
    if (window.lucide) window.lucide.createIcons();
  }

  /* ---------- EXPORTS ---------- */
  function exportCsv() {
    const queue = getFilteredServiceQueue();
    const headers = ['PMS Number', 'Vehicle', 'Color', 'VIN', 'Customer', 'Rider', 'Depot', 'Odometer', 'Current Service', 'Due Status', 'Days Remaining', 'Work Status', 'Scheduled Date', 'Actual Odo', 'Notes'];
    const lines = queue.map(v => {
      const dueStatus = serviceDueStatus(v).label;
      const days = daysUntil(v.dueDate);
      return [
        v.currentPmsTicket || '', v.model, v.color, v.vin, v.customer, v.rider || '', v.depot || '',
        safeNum(v.odometer), v.lastService || 'No service yet', dueStatus, days, v.workStatus,
        v.scheduledDate || '', v.actualOdo === '' || v.actualOdo == null ? '' : safeNum(v.actualOdo), v.notes || ''
      ];
    });
    const csv = [headers, ...lines].map(row => row.map(x => `"${String(x ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `fleetline-service-schedule-${U().dateInputValue(new Date())}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportPdf() {
    if (!window.jspdf?.jsPDF) { deps.toast('PDF export is unavailable.'); return; }
    const { jsPDF } = window.jspdf;
    const queue = getFilteredServiceQueue();
    const user = deps.getCurrentUser();
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    pdf.setFillColor(230, 57, 70); pdf.rect(0, 0, pageW * 0.33, 6, 'F');
    pdf.setFillColor(243, 107, 36); pdf.rect(pageW * 0.33, 0, pageW * 0.34, 6, 'F');
    pdf.setFillColor(50, 104, 232); pdf.rect(pageW * 0.67, 0, pageW * 0.33, 6, 'F');
    pdf.setFontSize(10); pdf.setTextColor(107, 114, 128); pdf.setFont('helvetica', 'bold');
    pdf.text('E88 VENTURES, INC.', 32, 28);
    pdf.setFont('helvetica', 'normal'); pdf.text('×  NRD', 155, 28);
    pdf.setFontSize(20); pdf.setTextColor(34, 35, 38); pdf.setFont('helvetica', 'bold');
    pdf.text('Service Schedule', 32, 56);
    pdf.setFontSize(9); pdf.setTextColor(107, 114, 128); pdf.setFont('helvetica', 'normal');
    const filterNote = buildFilterNote();
    const meta = `Generated ${new Date().toLocaleString('en-US')}  ·  ${queue.length} record${queue.length === 1 ? '' : 's'}  ·  ${user?.name || user?.email || 'System'}${filterNote}`;
    pdf.text(meta, 32, 72);
    const headers = ['PMS #', 'Vehicle', 'VIN', 'Customer', 'Rider / Depot', 'Odometer', 'Current Service', 'Due Status', 'Days', 'Work Status', 'Scheduled', 'Actual Odo', 'Notes'];
    const rows = queue.map(v => {
      const days = daysUntil(v.dueDate);
      return [
        v.currentPmsTicket || '—', `${v.model} ${v.color}`, v.vin, v.customer,
        [v.rider, v.depot].filter(Boolean).join(' · ') || '—',
        `${formatNumber(v.odometer)} km`, v.lastService || 'No service yet', serviceDueStatus(v).label, String(days),
        v.workStatus, v.scheduledDate ? formatDate(v.scheduledDate) : '—',
        v.actualOdo === '' || v.actualOdo == null ? '—' : `${formatNumber(v.actualOdo)} km`, v.notes || ''
      ];
    });
    pdf.autoTable({
      head: [headers], body: rows, startY: 88, theme: 'grid',
      styles: { fontSize: 7, cellPadding: 3, overflow: 'linebreak', textColor: [55, 56, 60], lineColor: [231, 229, 225], lineWidth: 0.5 },
      headStyles: { fillColor: [243, 107, 36], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
      alternateRowStyles: { fillColor: [250, 249, 247] },
      columnStyles: { 0: { cellWidth: 60 }, 1: { cellWidth: 55 }, 2: { cellWidth: 105 }, 3: { cellWidth: 70 }, 4: { cellWidth: 75 }, 5: { cellWidth: 50 }, 6: { cellWidth: 60 }, 7: { cellWidth: 50 }, 8: { cellWidth: 30 }, 9: { cellWidth: 55 }, 10: { cellWidth: 60 }, 11: { cellWidth: 'auto' } },
      margin: { left: 32, right: 32, top: 88, bottom: 40 },
      didDrawPage: () => {
        const page = pdf.internal.getNumberOfPages();
        pdf.setFontSize(8); pdf.setTextColor(150, 154, 160);
        pdf.text('Fleetline · E88 Ventures, Inc. × NRD', 32, pageH - 20);
        pdf.text(`Page ${page}`, pageW - 32, pageH - 20, { align: 'right' });
      }
    });
    pdf.save(`fleetline-service-schedule-${U().dateInputValue(new Date())}.pdf`);
  }

  function buildFilterNote() {
    const parts = [];
    if (activeServiceTab && activeServiceTab !== 'all') {
      const label = activeServiceTab.replaceAll('-', ' ');
      parts.push(label.charAt(0).toUpperCase() + label.slice(1));
    }
    if (serviceSearchTerm) parts.push(`search: "${serviceSearchTerm}"`);
    if (parts.length === 0) return '';
    return '  ·  Filtered: ' + parts.join(', ');
  }

  /* ---------- PUBLIC ---------- */
  function getBadgeCounts() {
    const vehicles = deps.getVehicles() || [];
    const overdue = vehicles.filter(v => v.fleetStatus !== 'Retired' && isOverdue(v)).length;
    const dueSoon = vehicles.filter(v => v.fleetStatus !== 'Retired' && isDueSoon(v)).length;
    return { overdue, dueSoon, total: overdue + dueSoon };
  }

  function render() {
    renderTabs();
    renderTable();
  }

  function init(options = {}) {
    deps = { ...deps, ...options };

    /* Search */
    const searchInput = document.querySelector('#service-search');
    if (searchInput) {
      searchInput.addEventListener('input', e => {
        clearTimeout(serviceSearchDebounceTimer);
        serviceSearchDebounceTimer = setTimeout(() => {
          serviceSearchTerm = e.target.value.trim();
          renderTable();
        }, 150);
      });
    }

    /* Row click → dialog */
    const rowsEl = document.querySelector('#service-rows');
    if (rowsEl) {
      rowsEl.addEventListener('click', e => {
        if (e.target.closest('[data-edit-odo]')) return;
        const row = e.target.closest('[data-service-id]');
        const v = (deps.getVehicles() || []).find(x => x.id === row?.dataset.serviceId);
        if (v) deps.openServiceDialog(v);
      });
      rowsEl.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-service-id]')) {
          e.preventDefault();
          const v = (deps.getVehicles() || []).find(x => x.id === e.target.dataset.serviceId);
          if (v) deps.openServiceDialog(v);
        }
      });

      /* Inline edit Actual Odo */
      rowsEl.addEventListener('click', async e => {
        const cell = e.target.closest('[data-edit-odo]');
        if (!cell) return;
        e.stopPropagation();
        const id = cell.dataset.editOdo;
        const v = (deps.getVehicles() || []).find(x => x.id === id);
        if (!v) return;
        const current = v.actualOdo === '' || v.actualOdo == null ? '' : String(v.actualOdo);
        const originalHtml = cell.innerHTML;
        cell.innerHTML = `<input type="number" min="0" step="1" class="inline-edit-input" value="${escapeHtml(current)}" />`;
        const input = cell.querySelector('input');
        input.focus(); input.select();
        let finished = false;
        async function commit(save) {
          if (finished) return;
          finished = true;
          const raw = input.value.trim();
          if (!save || raw === current) { cell.innerHTML = originalHtml; return; }
          const newOdo = raw === '' ? '' : safeNum(raw);
          const snapshot = { ...v };
          v.actualOdo = newOdo;
          cell.innerHTML = newOdo === '' ? '—' : `${formatNumber(newOdo)} km`;
          try {
            await deps.sheetsMutate('update', { vehicle: v });
            deps.writeCache(deps.getVehicles());
            deps.toast(`Actual odo updated for ${v.model}`);
            renderTable();
          } catch (err) {
            const idx = deps.getVehicles().findIndex(x => x.id === snapshot.id);
            if (idx >= 0) deps.getVehicles()[idx] = snapshot;
            cell.innerHTML = originalHtml;
            deps.toastError(`Couldn't save ${v.model}: ${err.message || 'Unknown error'}`);
          }
        }
        input.addEventListener('blur', () => commit(true));
        input.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
          if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
        });
      });
    }

    /* Exports */
    document.querySelector('#export-service-csv')?.addEventListener('click', exportCsv);
    document.querySelector('#export-service-pdf')?.addEventListener('click', exportPdf);
  }

  window.ServiceView = {
    init,
    render,
    getBadgeCounts,
    getFilteredQueue: getFilteredServiceQueue,
    exportCsv,
    exportPdf
  };
})();