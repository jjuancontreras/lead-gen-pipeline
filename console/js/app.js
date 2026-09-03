'use strict';
/**
 * Boot + the wiring that doesn't belong to one specific concern: search,
 * tier/presence/sort filters, the campaign-area select, keyboard shortcuts,
 * and the initial data load. See dom.js for the "no innerHTML" rule that
 * governs every module here.
 */
import { el } from './dom.js';
import { state } from './state.js';
import { refreshUI, clearFilters } from './inbox.js';
import { select, closeDetail, renderDetail } from './detail-panel.js';
import { loadLeads } from './data.js';
import { loadAreas, openOps, closeOps, setBboxReadout, logLine } from './campaign.js';

el('refresh').onclick = () => { loadLeads(); loadAreas(); };
el('areaSel').addEventListener('change', (e) => { state.area = e.target.value; loadLeads(); });

/* ---- toolbar wiring ----------------------------------------------------- */

let qTimer = null;
el('q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  const v = e.target.value;
  qTimer = setTimeout(() => { state.q = v; refreshUI(); }, 110);
});
el('qclear').onclick = () => { el('q').value = ''; state.q = ''; el('q').focus(); refreshUI(); };
el('presence').addEventListener('change', (e) => { state.presence = e.target.value; refreshUI(); });
el('sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  state.dir = e.target.value === 'name' ? 1 : -1;
  refreshUI();
});
el('clearall').onclick = clearFilters;
document.querySelectorAll('.seg button').forEach((b) => {
  b.addEventListener('click', () => {
    const t = b.dataset.tier;
    const on = b.getAttribute('aria-pressed') === 'true';
    b.setAttribute('aria-pressed', on ? 'false' : 'true');
    if (on) state.tiers.delete(t); else state.tiers.add(t);
    refreshUI();
  });
});

/* ---- keyboard ------------------------------------------------------------ */

function moveSelection(delta) {
  if (!state.view.length) return;
  const i = state.selected ? state.view.findIndex((l) => l.lead_id === state.selected.lead_id) : -1;
  const next = Math.max(0, Math.min(state.view.length - 1, i < 0 ? 0 : i + delta));
  select(state.view[next]);
  const tr = el('leads').querySelector('tr[aria-selected="true"]');
  if (tr) { tr.focus({ preventScroll:true }); tr.scrollIntoView({ block:'nearest' }); }
}

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === 'Escape') {
    if (!el('ops').hidden) { closeOps(); return; }
    if (typing) { document.activeElement.blur(); return; }
    if (state.selected) { closeDetail(); return; }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); el('q').focus(); el('q').select(); return; }
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); return; }
  if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); return; }
  if (e.key === 'r') { e.preventDefault(); loadLeads(); loadAreas(); return; }
  if (e.key === 'a') { e.preventDefault(); openOps(); return; }
});

/* ---- boot ------------------------------------------------------------------ */

logLine('idle — pick an area and run a campaign.', 'l-idle');
setBboxReadout();
renderDetail();
refreshUI();
loadAreas();
loadLeads();
