'use strict';
import { el, h } from './dom.js';
import { VIEWS, VIEW_BY, statusMeta, presenceMeta, reasonTone, splitNotes } from './vocabulary.js';
import { num, bestContact } from './format.js';
import { state } from './state.js';
// Cyclic with detail-panel.js by design - see the note there.
import { select } from './detail-panel.js';
import { openOps } from './campaign.js';
import { loadLeads } from './data.js';

/* ---- filtering + sorting ------------------------------------------------ */

export function computeView() {
  const q = state.q.trim().toLowerCase();
  let rows = state.leads.filter((l) => {
    if (state.tiers.size) {
      const t = l.tier || '-';
      if (!state.tiers.has(t)) return false;
    }
    if (state.tab !== 'all') {
      const v = VIEW_BY[state.tab];
      if (v && v.statuses && !v.statuses.includes(l.status)) return false;
    }
    if (state.presence) {
      const m = presenceMeta(l.website_kind);
      if (state.presence === 'prime') { if (m.band !== 'prime' && m.band !== 'strong') return false; }
      else if (state.presence === 'facebook') { if (l.website_kind !== 'facebook') return false; }
      else if (state.presence === 'none') { if (l.website_kind !== 'none') return false; }
      else if (m.band !== state.presence) return false;
    }
    if (q) {
      const hay = [l.name, l.category, l.notes, l.email, l.phone, l.instagram, l.facebook, l.area, l.status]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tierRank = (t) => (t === 'A' ? 3 : t === 'B' ? 2 : t === 'C' ? 1 : 0);
  const keyed = {
    score: (l) => num(l.osm_score),
    opportunity: (l) => presenceMeta(l.website_kind).rank,
    tier: (l) => tierRank(l.tier),
    status: (l) => -statusMeta(l.status).order,
    reviews: (l) => num(l.review_count),
    rating: (l) => num(l.rating),
  };
  const d = state.dir;
  if (state.sort === 'name') {
    // dir 1 = A→Z, dir -1 = Z→A.
    rows = rows.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)) * d);
  } else {
    const f = keyed[state.sort] || keyed.score;
    rows = rows.slice().sort((a, b) => (f(b) - f(a)) * (d === -1 ? 1 : -1) || String(a.name).localeCompare(String(b.name)));
  }
  state.view = rows;
}

/* ---- pipeline strip (view tabs) ------------------------------------------ */

function viewCount(v) {
  if (!v.statuses) {
    let n = 0;
    for (const [k, c] of Object.entries(state.counts)) if (k !== 'sourced') n += c;
    return n;
  }
  return v.statuses.reduce((sum, k) => sum + (state.counts[k] || 0), 0);
}

function renderPipeline() {
  const nav = el('pipeline');
  const kids = VIEWS.map((v) => {
    const n = viewCount(v);
    const on = state.tab === v.key;
    return h('button', {
      class: 'stage' + (n ? '' : ' empty'),
      attrs: { type:'button', role:'tab', 'aria-selected': on ? 'true' : 'false', title: v.hint },
      on: { click: () => { state.tab = v.key; refreshUI(); } },
    }, h('span', { text: v.label }), h('span', { class:'n', text: n }));
  });
  nav.replaceChildren(...kids);
}

function renderStats() {
  const shown = state.view.length;
  const inbox = state.leads.length;
  el('stats').replaceChildren(
    h('span', null, h('b', { text: state.total }), document.createTextNode(' in store')),
    h('span', null, h('b', { text: inbox }), document.createTextNode(' in inbox')),
    h('span', null, h('b', { text: shown }), document.createTextNode(' shown')),
  );
  const filtering = state.q || state.tiers.size || state.tab !== 'all' || state.presence;
  el('clearall').hidden = !filtering;
  el('qclear').hidden = !state.q;
}

/* ---- table -------------------------------------------------------------- */

const COLS = [
  { key:'name',        label:'Business',     sort:'name',        class:'c-name' },
  { key:'presence',    label:'Web presence', sort:'opportunity', class:'c-presence' },
  { key:'tier',        label:'Tier',         sort:'tier',        class:'c-tier' },
  { key:'score',       label:'Score',        sort:'score',       class:'c-score' },
  { key:'status',      label:'Stage',        sort:'status',      class:'c-status' },
  { key:'contact',     label:'Contact',      sort:null,          class:'c-contact' },
];

function renderHead() {
  const tr = el('headrow');
  tr.replaceChildren(...COLS.map((c) => {
    const active = c.sort && state.sort === c.sort;
    const th = h('th', {
      class: c.class + (c.sort ? ' sortable' : ''),
      attrs: { scope:'col', tabindex: c.sort ? '0' : null },
    }, h('span', { text: c.label }), h('span', { class:'arrow', text: state.dir === -1 ? '▼' : '▲' }));
    if (active) th.setAttribute('aria-sort', state.dir === -1 ? 'descending' : 'ascending');
    if (c.sort) {
      const go = () => {
        if (state.sort === c.sort) state.dir = -state.dir;
        else { state.sort = c.sort; state.dir = c.sort === 'name' ? 1 : -1; }
        el('sort').value = state.sort;
        refreshUI();
      };
      th.addEventListener('click', go);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    }
    return th;
  }));
}

function skeletonRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const tr = h('tr', { attrs:{ 'aria-hidden':'true' } });
    COLS.forEach((c, j) => {
      tr.append(h('td', { class:c.class },
        h('div', { class:'skel', style:'width:' + (j === 0 ? 55 + (i % 4) * 8 : 40) + '%' })));
    });
    rows.push(tr);
  }
  return rows;
}

export function renderTable() {
  const tb = el('leads');
  const stateBox = el('tablestate');

  if (state.loading) {
    tb.replaceChildren(...skeletonRows(10));
    stateBox.replaceChildren();
    return;
  }
  if (state.error) {
    tb.replaceChildren();
    stateBox.replaceChildren(h('div', { class:'state' },
      h('h3', { text:'Could not load leads' }),
      h('p', { text: state.error }),
      h('button', { class:'btn', text:'Try again', on:{ click: loadLeads } })));
    return;
  }
  if (!state.view.length) {
    tb.replaceChildren();
    stateBox.replaceChildren(h('div', { class:'state' },
      h('h3', { text: state.leads.length ? 'Nothing matches these filters' : 'The inbox is empty' }),
      h('p', { text: state.leads.length
          ? 'Loosen a filter, or clear them all and start again.'
          : 'Define an area and run a campaign to source leads into it.' }),
      state.leads.length
        ? h('button', { class:'btn', text:'Clear filters', on:{ click: clearFilters } })
        : h('button', { class:'btn btn-accent', text:'Open areas & campaigns', on:{ click: openOps } })));
    return;
  }

  stateBox.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const l of state.view) {
    frag.append(rowFor(l));
  }
  tb.replaceChildren(frag);
}

function rowFor(l) {
  const pm = presenceMeta(l.website_kind);
  const sm = statusMeta(l.status);
  const reasons = splitNotes(l.notes);
  const lead = reasons.find((r) => reasonTone(r) === 'good') || reasons[0] || '';
  const selected = state.selected && state.selected.lead_id === l.lead_id;

  const tr = h('tr', {
    attrs: {
      tabindex:'0',
      'aria-selected': selected ? 'true' : 'false',
      'data-id': l.lead_id,
    },
    on: {
      click: () => select(l),
      keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(l); } },
    },
  });

  // Business: name, the single strongest reason, then category/area.
  const why = h('div', { class:'why' + (reasonTone(lead) === 'good' ? ' good' : ''), text: lead || (l.category || '') });
  if (lead) why.setAttribute('title', l.notes || '');
  const nameCell = h('td', { class:'c-name' }, h('div', { class:'biz' },
    h('div', { class:'nm', text: l.name || '(unnamed)' }),
    why,
    lead ? h('div', { class:'meta', text: [l.category, l.area].filter(Boolean).join(' · ') }) : null));
  tr.append(nameCell);

  tr.append(h('td', { class:'c-presence' },
    h('span', { class:'badge op-' + pm.band, text: pm.label, attrs:{ title: pm.say } })));

  tr.append(h('td', { class:'c-tier' }, l.tier
    ? h('span', { class:'badge tier tier-' + l.tier, text:l.tier, attrs:{ title:'Tier ' + l.tier } })
    : h('span', { class:'badge tier tier-none', text:'–', attrs:{ title:'Not yet tiered' } })));

  const score = num(l.osm_score);
  tr.append(h('td', { class:'c-score num', text: l.osm_score ? String(score) : '–' }));

  tr.append(h('td', { class:'c-status' },
    h('span', { class:'badge st', style:'--sc:' + sm.color, attrs:{ title: sm.hint } },
      h('span', { class:'tick', attrs:{ 'aria-hidden':'true' } }), h('span', { text: sm.label }))));

  const c = bestContact(l);
  tr.append(h('td', { class:'c-contact' }, c
    ? h('div', { class:'contact' }, h('span', { class:'ch', text:c.ch }), h('span', { class:'v', text:c.v, attrs:{ title:c.v } }))
    : h('span', { class:'none', text:'no channel' })));

  return tr;
}

/* ---- exported for app.js and the async data loaders ---------------------- */

export function refreshUI() {
  computeView();
  renderPipeline();
  renderHead();
  renderTable();
  renderStats();
}

export function clearFilters() {
  state.q = ''; el('q').value = '';
  state.tiers.clear(); state.tab = 'all'; state.presence = '';
  el('presence').value = '';
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  refreshUI();
}
