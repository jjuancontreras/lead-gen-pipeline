'use strict';
import { state } from './state.js';
import { refreshUI, renderTable } from './inbox.js';
import { renderDetail, loadDraft } from './detail-panel.js';

export async function loadLeads() {
  state.loading = true; state.error = null;
  renderTable();
  try {
    const qs = state.area ? ('?area=' + encodeURIComponent(state.area)) : '';
    const res = await fetch('/api/leads' + qs);
    if (!res.ok) throw new Error('server returned ' + res.status);
    const d = await res.json();
    state.leads = Array.isArray(d.leads) ? d.leads : [];
    state.counts = d.counts || {};
    state.total = d.total || state.leads.length;
    state.loading = false;
    if (state.selected) {
      const again = state.leads.find((l) => l.lead_id === state.selected.lead_id);
      state.selected = again || null;
      // The row still exists - refresh what it can send, in case a run
      // since the last load wrote or withdrew a draft for it.
      if (again) loadDraft(again);
      else state.draft = { loading: false, data: null };
    }
  } catch (err) {
    state.loading = false;
    state.error = err.message || 'network error';
  }
  refreshUI();
  renderDetail();
}
