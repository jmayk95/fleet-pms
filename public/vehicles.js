/* ============================================================
   FLEETLINE · vehicles.js
   Vehicle table render, search, filters, sort, bulk selection +
   dialogs, mobile filter sheet, CSV/PDF export, focusVehicle.
   Exposes: window.VehiclesView
   ============================================================ */

(function () {
  'use strict';

  let deps = {
    getVehicles: () => [],
    getFilteredVehicles: () => [],
    setFilteredVehicles: () => {},
    getServiceLog: () => [],
    getVehiclePmStatus: () => '',
    openDrawer: () => {},
    confirm: () => Promise.resolve(false),
    toast: () => {},
    toastError: () => {},
    recordActivity: () => {},
    invalidateCache: () => {},
    loadVehiclesFromSheets: () => Promise.resolve([]),
    renderAll: () => {},
    getActiveView: () => 'overview',
    getCurrentUser: () => null,
    getSortState: () => ({ key: null, dir: 'asc' }),
    setSortState: () => {},
    openBulkStatus: () => {},
    openBulkCustomer: () => {},
    bulkDelete: () => {}
  };

  let searchTerm = '';
  let advancedFilters = { model: '', customer: '', depot: '', fleetStatus: '', pmStatus: '' };
  let selectedVehicleIds = new Set();
  let searchDebounceTimer = null;

  function U() { return window.FleetUtils; }

  function formatNumber(n) { return U().formatNumber(n); }
  function formatDate(v) { return U().formatDate(v); }
  function escapeHtml(v) { return U().escapeHtml(v); }
  function getVehicleImage(m, c, p) { return U().getVehicleImage(m, c, p); }
  function isComplete(v) { return U().isComplete(v); }
  function isOverdue(v) { return U().isOverdue(v); }
  function isDueSoon(v) { return U().isDueSoon(v); }
  function daysUntil(d) { return U().daysUntil(d); }
  function safeNum(n) { return U().safeNum(n); }
  function vehiclePmStatus(v) { return deps.getVehiclePmStatus(v); }
  function SERVICE_SCHEDULE() { return U().SERVICE_SCHEDULE; }

  /* ---------- ROW ---------- */
  function vehicleRow(v) {
    const complete = isComplete(v);
    const overdue = isOverdue(v);
    const days = daysUntil(v.dueDate);
    const remaining = safeNum(v.threshold) - safeNum(v.odometer);
    const nextService = SERVICE_SCHEDULE().find(s => s.milestone === v.nextMilestone);
    const lastServiceInfo = SERVICE_SCHEDULE().find(s => s.milestone === v.lastService);
    const serviceLog = deps.getServiceLog() || [];
    const lastServiceEntry = v.lastService
      ? serviceLog.find(log => log.vehicleId === v.id && log.milestone === v.lastService)
      : null;
      
    const statusClass = v.fleetStatus === 'Retired' ? 'status-retired'
      : v.fleetStatus === 'Maintenance Hold' ? 'status-hold'
      : v.fleetStatus === 'In Service - Due PM' ? 'status-due'
      : 'status-active';
      
    const dueSoon = isDueSoon(v);
    const pmClass = complete ? 'pm-complete' : overdue ? 'pm-overdue' : dueSoon ? 'pm-due' : 'pm-ok';
    const pmLabel = complete ? 'Complete' : overdue ? 'Overdue' : dueSoon ? 'Due Soon' : 'On Track';
    const leftText = complete ? 'All complete' : `${formatNumber(remaining)} km`;
    const leftClass = !complete && remaining < 0 ? 'remaining-cell is-negative' : 'remaining-cell';
    const dueText = complete ? 'Service complete' : days < 0 ? `${Math.abs(days)} days overdue` : days === 0 ? 'Due today' : `In ${days} days`;
    const dueClass = overdue ? 'due-over' : '';
    const isSelected = selectedVehicleIds.has(v.id);
    
    return `<tr data-id="${escapeHtml(v.id)}" class="${isSelected ? 'is-selected' : ''}">
      <td class="row-checkbox" data-label="Select">
        <input type="checkbox" data-row-select="${escapeHtml(v.id)}" ${isSelected ? 'checked' : ''} aria-label="Select vehicle" />
      </td>
      <td data-label="Vehicle"><div class="vehicle-cell">
        ${getVehicleImage(v.model, v.color)
${getVehicleImage(v.model, v.color)
  ? `<img src="${getVehicleImage(v.model, v.color)}"
       onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"
       class="vehicle-avatar-img" />`
  : ''}
        <i class="fa-solid fa-motorcycle" style="display:none; font-size: 20px; color: var(--primary); margin-right: 8px;"></i>
        <span class="vehicle-primary"><strong>${escapeHtml(v.model)}</strong><span>${escapeHtml(v.color)}</span></span>
      </div></td>
      <td data-label="VIN">${escapeHtml(v.vin)}</td>
      <td class="customer-cell" data-label="Customer">
        <div class="vehicle-primary">
          <strong>${escapeHtml(v.customer)}</strong>
          <span>${escapeHtml(v.depot || '—')}</span>
        </div>
      </td>
      <td data-label="Rider">
        <div class="vehicle-primary">
          <strong>${escapeHtml(v.rider || '—')}</strong>
          <span class="td-vin">${escapeHtml(v.vin || '—')}</span>
        </div>
      </td>
      <td class="odometer-cell" data-label="Odometer">${formatNumber(v.odometer)} km</td>
      <td data-label="Fleet Status"><span class="status-chip ${statusClass}">${escapeHtml(v.fleetStatus)}</span></td>
      <td data-label="Last Service">
        <div class="service-cell">
          <strong>${v.lastService ? `${escapeHtml(v.lastService)} · ${lastServiceInfo ? lastServiceInfo.months : ''} mo` : 'No service yet'}</strong>
          <span>${lastServiceEntry ? formatDate(lastServiceEntry.completedAt) : ''}</span>
        </div>
      </td>
      <td data-label="Next Service">
        <div class="due-cell">
          <strong>${escapeHtml(v.nextMilestone)}${nextService ? ` · ${nextService.months} mo` : ''}</strong>
          <span class="${dueClass}">${complete ? 'Service complete' : `${formatDate(v.dueDate)} · ${dueText}`}</span>
        </div>
      </td>
      <td class="${leftClass}" data-label="Km remaining">${leftText}</td>
      <td data-label="PM"><span class="pm-chip ${pmClass}">${pmLabel}</span></td>
    </tr>`;
  }

  /* ---------- SORT ---------- */
  function applySort(list) {
    const sortState = deps.getSortState();
    if (!sortState.key) return list;
    const dir = sortState.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      let va = a[sortState.key], vb = b[sortState.key];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  function updateSortArrows() {
    const sortState = deps.getSortState();
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.sort === sortState.key) th.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    });
  }

  /* ---------- ADVANCED FILTER OPTIONS ---------- */
  function renderAdvancedFilterOptions() {
    const vehicles = deps.getVehicles() || [];
    const filters = [
      ['model', 'All models', vehicles.map(v => v.model)],
      ['customer', 'All customers', vehicles.map(v => v.customer)],
      ['depot', 'All depots', vehicles.map(v => v.depot).filter(Boolean)],
      ['fleetStatus', 'All fleet statuses', vehicles.map(v => v.fleetStatus)],
      ['pmStatus', 'All PM statuses', vehicles.map(vehiclePmStatus)]
    ];
    for (const [key, placeholder, values] of filters) {
      const select = document.querySelector(`[data-advanced-filter="${key}"]`);
      if (!select) continue;
      const options = [...new Set(values)].filter(Boolean).sort((a, b) => a.localeCompare(b));
      if (advancedFilters[key] && !options.includes(advancedFilters[key])) advancedFilters[key] = '';
      select.innerHTML = `<option value="">${placeholder}</option>${options.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}`;
      select.value = advancedFilters[key];
    }
    const activeCount = Object.values(advancedFilters).filter(Boolean).length;
    const count = document.querySelector('#advanced-filter-count');
    if (count) { count.textContent = activeCount; count.hidden = activeCount === 0; }
    const toggle = document.querySelector('#advanced-filter-toggle');
    if (toggle) toggle.classList.toggle('has-filters', activeCount > 0);
  }

  /* ---------- BULK SELECTION ---------- */
  function syncBulkSelectionUI() {
    const bar = document.querySelector('#bulk-action-bar');
    const count = document.querySelector('#bulk-action-count');
    if (!bar || !count) return;
    const n = selectedVehicleIds.size;
    bar.hidden = n === 0;
    count.textContent = `${n} vehicle${n === 1 ? '' : 's'} selected`;
    const selectAll = document.querySelector('#vehicle-select-all');
    if (selectAll) {
      const visibleIds = (deps.getFilteredVehicles() || []).map(v => v.id);
      const visibleSelected = visibleIds.filter(id => selectedVehicleIds.has(id));
      selectAll.checked = visibleIds.length > 0 && visibleSelected.length === visibleIds.length;
      selectAll.indeterminate = visibleSelected.length > 0 && visibleSelected.length < visibleIds.length;
    }
  }

  function clearBulkSelection() {
    selectedVehicleIds.clear();
    document.querySelectorAll('#vehicle-rows tr.is-selected').forEach(tr => tr.classList.remove('is-selected'));
    document.querySelectorAll('#vehicle-rows input[data-row-select]').forEach(cb => { cb.checked = false; });
    syncBulkSelectionUI();
  }

  /* ---------- MAIN RENDER ---------- */
  function render() {
    const vehicles = deps.getVehicles() || [];
    renderAdvancedFilterOptions();
    const needle = searchTerm.toLowerCase();
    let filtered = vehicles.filter(v => {
      const matchesSearch = !needle || [v.model, v.color, v.vin, v.plate, v.customer, v.rider, v.depot, v.fleetStatus, v.notes]
        .some(x => String(x).toLowerCase().includes(needle));
      const matchesAdvanced = ['model', 'customer', 'depot', 'fleetStatus']
        .every(k => !advancedFilters[k] || v[k] === advancedFilters[k])
        && (!advancedFilters.pmStatus || vehiclePmStatus(v) === advancedFilters.pmStatus);
      return matchesSearch && matchesAdvanced;
    });
    filtered = applySort(filtered);
    deps.setFilteredVehicles(filtered);

    const rows = document.querySelector('#vehicle-rows');
    if (rows) rows.innerHTML = filtered.map(vehicleRow).join('');

    const fac = document.querySelector('#filter-all-count');
    if (fac) fac.textContent = vehicles.length;

    syncBulkSelectionUI();

    const emptyState = document.querySelector('#empty-state');
    if (emptyState) {
      emptyState.hidden = filtered.length > 0;
      if (filtered.length === 0 && vehicles.length > 0) {
        emptyState.innerHTML = `<span class="empty-icon"><i data-lucide="search-x"></i></span>
          <strong>No vehicles match${searchTerm ? ` "${escapeHtml(searchTerm)}"` : ''}.</strong>
          <span>Try a different keyword or clear the filters.</span>`;
      } else if (vehicles.length === 0) {
        emptyState.innerHTML = `<span class="empty-icon"><i data-lucide="truck"></i></span>
          <strong>No vehicles yet.</strong>
          <span>Click "Add vehicle" to get started.</span>`;
      } else {
        emptyState.innerHTML = `<span class="empty-icon"><i data-lucide="search-x"></i></span>
          <strong>No vehicles found</strong>
          <span>Try another search or change the selected filter.</span>`;
      }
    }

    const tableSummary = document.querySelector('#table-summary');
    if (tableSummary) tableSummary.textContent = `Showing ${filtered.length} of ${vehicles.length} vehicles`;
    updateSortArrows();
    if (window.lucide) window.lucide.createIcons();
  }

  /* ---------- EXPORTS ---------- */
  function exportCsv() {
    const filtered = deps.getFilteredVehicles() || [];
    const headers = ['Model', 'Color', 'VIN', 'Plate', 'Customer', 'Rider', 'Depot', 'Sale Date', 'Odometer', 'Fleet Status', 'Current Odo', 'Last Service', 'Next Milestone', 'Threshold', 'Due Date', 'Days', 'Km Remaining', 'PM Status'];
    const lines = filtered.map(v => {
      const complete = isComplete(v);
      const days = complete ? '' : daysUntil(v.dueDate);
      const remaining = complete ? '' : safeNum(v.threshold) - safeNum(v.odometer);
      const pm = complete ? 'Complete' : isOverdue(v) ? 'Overdue' : 'On Track';
      return [v.model, v.color, v.vin, v.plate, v.customer, v.rider, v.depot, v.saleDate, v.odometer, v.fleetStatus, safeNum(v.odometer), v.lastService, v.nextMilestone, v.threshold, v.dueDate, days, remaining, pm];
    });
    const csv = [headers, ...lines].map(row => row.map(x => `"${String(x ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'fleet-register.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportBrandedPdf() {
    if (!window.jspdf?.jsPDF) { deps.toast('PDF export is unavailable.'); return; }
    const { jsPDF } = window.jspdf;
    const filtered = deps.getFilteredVehicles() || [];
    const user = deps.getCurrentUser();
    const today = new Date();
    const dateInputValue = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    pdf.text('Fleet Register', 32, 56);
    pdf.setFontSize(9); pdf.setTextColor(107, 114, 128); pdf.setFont('helvetica', 'normal');
    const meta = `Generated ${new Date().toLocaleString('en-US')}  ·  ${filtered.length} vehicle${filtered.length === 1 ? '' : 's'}  ·  ${user?.name || user?.email || 'System'}`;
    pdf.text(meta, 32, 72);
    const headers = ['Vehicle', 'VIN', 'Customer', 'Rider', 'Depot', 'Odometer', 'Fleet Status', 'Current Odo', 'Current Service', 'Next Service', 'Due', 'PM Status'];
    const rows = filtered.map(v => {
      const days = daysUntil(v.dueDate);
      return [`${v.model} ${v.color}`, v.vin, v.customer, v.rider, v.depot, `${formatNumber(v.odometer)} km`, v.fleetStatus, `${formatNumber(v.odometer)} km`, v.lastService || 'No service yet', v.nextMilestone, isComplete(v) ? 'Complete' : `${formatDate(v.dueDate)} (${days}d)`, vehiclePmStatus(v)];
    });
    pdf.autoTable({
      head: [headers], body: rows, startY: 88, theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 4, overflow: 'linebreak', textColor: [55, 56, 60], lineColor: [231, 229, 225], lineWidth: 0.5 },
      headStyles: { fillColor: [243, 107, 36], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: [250, 249, 247] },
      margin: { left: 32, right: 32, top: 88, bottom: 40 },
      didDrawPage: () => {
        const page = pdf.internal.getNumberOfPages();
        pdf.setFontSize(8); pdf.setTextColor(150, 154, 160);
        pdf.text('Fleetline · E88 Ventures, Inc. × NRD', 32, pageH - 20);
        pdf.text(`Page ${page}`, pageW - 32, pageH - 20, { align: 'right' });
      }
    });
    pdf.save(`fleetline-register-${dateInputValue(today)}.pdf`);
  }

  /* ---------- MOBILE FILTER SHEET ---------- */
  function openFilterSheet() {
    let sheet = document.querySelector('.mobile-filter-sheet');
    let backdrop = document.querySelector('.mobile-filter-backdrop');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.className = 'mobile-filter-sheet';
      sheet.innerHTML = `
        <div class="mobile-filter-sheet-handle"></div>
        <h3>Advanced filters</h3>
        <div class="advanced-filters">
          <label>Model<select data-advanced-filter="model"><option value="">All models</option></select></label>
          <label>Customer<select data-advanced-filter="customer"><option value="">All customers</option></select></label>
          <label>Depot<select data-advanced-filter="depot"><option value="">All depots</option></select></label>
          <label>Fleet status<select data-advanced-filter="fleetStatus"><option value="">All fleet statuses</option></select></label>
          <label>PM status<select data-advanced-filter="pmStatus"><option value="">All PM statuses</option></select></label>
          <div class="filter-sheet-actions">
            <button class="button button-secondary" type="button" id="mobile-filter-clear">Clear</button>
            <button class="button button-primary" type="button" id="mobile-filter-apply">Apply</button>
          </div>
        </div>`;
      document.body.appendChild(sheet);
      backdrop = document.createElement('div');
      backdrop.className = 'mobile-filter-backdrop';
      document.body.appendChild(backdrop);
      populateMobileFilters();
      sheet.querySelector('#mobile-filter-clear').addEventListener('click', () => {
        advancedFilters = { model: '', customer: '', depot: '', fleetStatus: '', pmStatus: '' };
        sheet.querySelectorAll('select').forEach(s => { s.value = ''; });
        deps.renderAll();
        closeFilterSheet();
      });
      sheet.querySelector('#mobile-filter-apply').addEventListener('click', () => { deps.renderAll(); closeFilterSheet(); });
      sheet.querySelectorAll('select').forEach(sel => {
        sel.addEventListener('change', e => { advancedFilters[e.target.dataset.advancedFilter] = e.target.value; });
      });
      backdrop.addEventListener('click', closeFilterSheet);
    }
    populateMobileFilters();
    requestAnimationFrame(() => { sheet.classList.add('visible'); backdrop.classList.add('visible'); });
  }
  
  function populateMobileFilters() {
    const sheet = document.querySelector('.mobile-filter-sheet');
    if (!sheet) return;
    const vehicles = deps.getVehicles() || [];
    const filters = [
      ['model', 'All models', vehicles.map(v => v.model)],
      ['customer', 'All customers', vehicles.map(v => v.customer)],
      ['depot', 'All depots', vehicles.map(v => v.depot).filter(Boolean)],
      ['fleetStatus', 'All fleet statuses', vehicles.map(v => v.fleetStatus)],
      ['pmStatus', 'All PM statuses', vehicles.map(vehiclePmStatus)]
    ];
    for (const [key, placeholder, values] of filters) {
      const select = sheet.querySelector(`[data-advanced-filter="${key}"]`);
      if (!select) continue;
      const options = [...new Set(values)].filter(Boolean).sort((a, b) => a.localeCompare(b));
      select.innerHTML = `<option value="">${placeholder}</option>${options.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}`;
      select.value = advancedFilters[key];
    }
  }
  
  function closeFilterSheet() {
    const sheet = document.querySelector('.mobile-filter-sheet');
    const backdrop = document.querySelector('.mobile-filter-backdrop');
    if (sheet) sheet.classList.remove('visible');
    if (backdrop) backdrop.classList.remove('visible');
  }

  /* ---------- FOCUS (from alerts popover) ---------- */
  function focusVehicle(vehicleId) {
    searchTerm = '';
    advancedFilters = { model: '', customer: '', depot: '', fleetStatus: '', pmStatus: '' };
    const input = document.querySelector('#vehicle-search');
    if (input) input.value = '';
    deps.renderAll();
    requestAnimationFrame(() => {
      setTimeout(() => {
        const targetRow = [...document.querySelectorAll('#vehicle-rows tr[data-id]')].find(r => r.dataset.id === vehicleId);
        if (!targetRow) { deps.toast('Vehicle not visible in this view.'); return; }
        targetRow.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        targetRow.classList.add('alert-target-highlight');
        setTimeout(() => targetRow.classList.remove('alert-target-highlight'), 3000);
      }, 60);
    });
  }

  /* ---------- INIT ---------- */
  function init(options = {}) {
    deps = { ...deps, ...options };

    /* Search */
    const searchInput = document.querySelector('#vehicle-search');
    if (searchInput) {
      searchInput.addEventListener('input', e => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          searchTerm = e.target.value.trim();
          render();
        }, 150);
      });
    }

    /* Advanced filter toggle */
    const advancedToggle = document.querySelector('#advanced-filter-toggle');
    if (advancedToggle) {
      advancedToggle.addEventListener('click', e => {
        if (window.matchMedia('(max-width: 640px)').matches) {
          e.stopImmediatePropagation();
          e.preventDefault();
          openFilterSheet();
          return;
        }
        const panel = document.querySelector('#advanced-filters');
        panel.hidden = !panel.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
      }, true);
    }

    /* Advanced filter changes */
    const advFilters = document.querySelector('#advanced-filters');
    if (advFilters) {
      advFilters.addEventListener('change', e => {
        const key = e.target.dataset.advancedFilter;
        if (!key) return;
        advancedFilters[key] = e.target.value;
        render();
      });
    }

    /* Clear filters */
    const clearBtn = document.querySelector('#clear-advanced-filters');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        advancedFilters = { model: '', customer: '', depot: '', fleetStatus: '', pmStatus: '' };
        searchTerm = '';
        const input = document.querySelector('#vehicle-search');
        if (input) input.value = '';
        render();
      });
    }

    /* Row selection */
    const rowsEl = document.querySelector('#vehicle-rows');
    if (rowsEl) {
      rowsEl.addEventListener('change', e => {
        const cb = e.target.closest('input[data-row-select]');
        if (!cb) return;
        e.stopPropagation();
        const id = cb.dataset.rowSelect;
        const tr = cb.closest('tr');
        if (cb.checked) { selectedVehicleIds.add(id); tr.classList.add('is-selected'); }
        else { selectedVehicleIds.delete(id); tr.classList.remove('is-selected'); }
        syncBulkSelectionUI();
      });
      
      rowsEl.addEventListener('click', e => {
        if (e.target.closest('input[data-row-select]')) return;
        const row = e.target.closest('tr[data-id]');
        if (!row) return;
        const v = (deps.getVehicles() || []).find(x => x.id === row.dataset.id);
        if (v) deps.openDrawer(v);
      });
    }

    /* Select-all */
    const selectAll = document.querySelector('#vehicle-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', e => {
        const checked = e.target.checked;
        (deps.getFilteredVehicles() || []).forEach(v => {
          if (checked) selectedVehicleIds.add(v.id);
          else selectedVehicleIds.delete(v.id);
        });
        document.querySelectorAll('#vehicle-rows input[data-row-select]').forEach(cb => {
          cb.checked = checked;
          cb.closest('tr').classList.toggle('is-selected', checked);
        });
        syncBulkSelectionUI();
      });
    }

    /* Exports */
    document.querySelector('#export-csv')?.addEventListener('click', exportCsv);
    document.querySelector('#export-pdf')?.addEventListener('click', exportBrandedPdf);

    /* Bulk: clear */
    document.querySelector('#bulk-clear')?.addEventListener('click', clearBulkSelection);
    
    /* Bulk: status */
    document.querySelector('#bulk-change-status')?.addEventListener('click', () => {
      if (typeof deps.openBulkStatus === 'function') deps.openBulkStatus(Array.from(selectedVehicleIds), selectedVehicleIds);
    });
    
    /* Bulk: customer */
    document.querySelector('#bulk-change-customer')?.addEventListener('click', () => {
      if (typeof deps.openBulkCustomer === 'function') deps.openBulkCustomer(Array.from(selectedVehicleIds), selectedVehicleIds);
    });
    
    /* Bulk: delete */
    document.querySelector('#bulk-delete')?.addEventListener('click', async () => {
      const ids = Array.from(selectedVehicleIds);
      if (ids.length === 0) return;
      if (typeof deps.bulkDelete === 'function') deps.bulkDelete(ids, () => { selectedVehicleIds.clear(); });
    });

  }

  /* ---------- PUBLIC API ---------- */
  window.VehiclesView = {
    init,
    render,
    clearBulkSelection,
    focusVehicle,
    exportCsv,
    exportBrandedPdf
  };
})();
