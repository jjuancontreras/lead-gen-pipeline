'use strict';
import { el, h } from './dom.js';
import { presenceMeta, statusMeta, splitNotes, reasonTone } from './vocabulary.js';
import { safeHttpUrl, socialUrl, num } from './format.js';
import { toast } from './toast.js';
import { state } from './state.js';
// Cyclic with inbox.js by design: the table and the detail rail are two
// views onto one selection, so each needs to re-render the other. Both
// references below are only read inside a function body (never at
// module-evaluation time), which ES modules' live bindings handle safely.
import { renderTable } from './inbox.js';
import { loadLeads } from './data.js';

/* ---- detail rail -------------------------------------------------------- */

export function select(l) {
  state.selected = l;
  state.draft = { loading: true, data: null };
  renderTable();
  renderDetail();
  if (window.matchMedia('(max-width:1040px)').matches) el('detail').classList.add('on');
  loadDraft(l);
}

export function closeDetail() {
  state.selected = null;
  state.draft = { loading: false, data: null };
  el('detail').classList.remove('on');
  renderTable();
  renderDetail();
}

/**
 * The message for one lead: the actual saved draft/withdrawal if one exists
 * on disk, or an unsaved live preview when it does not - already structured
 * by the server, so there is no markdown to parse back apart here. `seq`
 * guards against a slow response landing after the user has already clicked
 * a different row.
 */
let draftSeq = 0;
export async function loadDraft(l) {
  const seq = ++draftSeq;
  let data;
  try {
    const res = await fetch('/api/draft?lead=' + encodeURIComponent(l.lead_id));
    data = await res.json();
    if (!res.ok) data = { kind:'none', reason: data.error || ('server returned ' + res.status) };
  } catch (err) {
    data = { kind:'none', reason: 'Network error loading the message.' };
  }
  if (seq !== draftSeq) return; // a newer selection has already superseded this
  state.draft = { loading: false, data };
  renderDetail();
}

function msgField(label, value) {
  return h('div', { class:'msgfield' },
    h('div', { class:'msgfield-head' }, h('span', { text:label }), copyBtn(value, label)),
    h('pre', { class:'msgbox', text:value }));
}

async function markSent(l) {
  if (!l) return;
  const ok = confirm('Mark "' + l.name + '" as sent?\n\n'
    + 'This confirms you already sent the message yourself, and starts the '
    + '3/7/14 follow-up clock in the live sheet. This cannot be undone from here.');
  if (!ok) return;
  try {
    const res = await fetch('/api/sent', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ lead_id: l.lead_id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    toast('Marked sent - ' + (data.patch.next_action_date
      ? 'follow-up due ' + data.patch.next_action_date : 'sequence finished'), 'ok');
    await loadLeads();
  } catch (err) {
    toast('Could not mark sent: ' + (err.message || 'error'), 'err');
  }
}

function copyBtn(value, what) {
  return h('button', {
    class:'btn btn-ghost btn-sm', text:'copy',
    attrs:{ 'aria-label':'Copy ' + what },
    on:{ click: async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(value); toast('Copied ' + what, 'ok'); }
      catch { toast('Clipboard blocked by the browser', 'err'); }
    } },
  });
}

function channelRow(label, value, href) {
  if (!value) return null;
  const row = h('div', { class:'chan' }, h('span', { class:'ch', text: label }));
  if (href) {
    const a = h('a', { text: value, attrs:{ href, rel:'noopener noreferrer', target:'_blank' } });
    row.append(a);
  } else {
    row.append(h('span', { class:'val', text: value }));
  }
  row.append(copyBtn(value, label));
  return row;
}

function linkRow(label, url, cta) {
  if (!url) return null;
  return h('div', { class:'chan' }, h('span', { class:'ch', text:label }),
    h('a', { text: cta || 'Open ▸', attrs:{ href:url, target:'_blank', rel:'noopener noreferrer' } }));
}

/** Where the demo, mockup and walkthrough video live - together, unmissable. */
function renderDemoSection(l) {
  const demoUrl = safeHttpUrl(l.demo_url), videoUrl = safeHttpUrl(l.video_url), mockupUrl = safeHttpUrl(l.mockup_url);
  if (!demoUrl && !videoUrl && !mockupUrl && !l.demo_slug) return null;
  const sec = h('section', { class:'dsec' }, h('h3', { text:'Demo & links' }));
  const rows = [
    linkRow('demo', demoUrl, 'Open demo ▸'),
    linkRow('video', videoUrl, 'Watch ▸'),
    linkRow('mockup', mockupUrl, 'Open ▸'),
  ].filter(Boolean);
  if (rows.length) rows.forEach((r) => sec.append(r));
  else sec.append(h('p', { class:'hint', style:'margin:0', text:'Slug reserved (' + l.demo_slug + ') but no link on file yet.' }));
  return sec;
}

/**
 * What you would actually send, or already did - a saved draft wins over a
 * live preview, and a withdrawal wins over both. This is the one place in
 * the console that shows outreach copy, so it is also the one place that has
 * to honour do_not_contact: the API already refuses to render for a
 * suppressed lead, and this just displays what it said.
 */
function renderMessageSection() {
  const sec = h('section', { class:'dsec' }, h('h3', { text:'Message' }));
  if (state.draft.loading) {
    sec.append(h('p', { class:'hint msgnote', text:'Loading…' }));
    return sec;
  }
  const d = state.draft.data;
  if (!d || d.kind === 'none') {
    sec.append(h('p', { class:'hint msgnote', text: (d && d.reason) || 'Nothing to show yet.' }));
    return sec;
  }
  if (d.kind === 'suppressed') {
    sec.append(h('p', { class:'hint msgnote', style:'color:var(--red)',
      text:'Flagged do_not_contact - no message is drafted or shown for this lead.' }));
    return sec;
  }

  const badges = {
    draft:     { t:'Draft saved – ready to send',   c:'var(--amber)' },
    preview:   { t:'Preview – not saved, not sent',  c:'var(--blue)' },
    withdrawn: { t:'Withdrawn – do not contact',      c:'var(--red)' },
  };
  const b = badges[d.kind];
  if (b) {
    sec.append(h('span', { class:'badge st', style:'--sc:' + b.c },
      h('span', { class:'tick', attrs:{ 'aria-hidden':'true' } }), h('span', { text:b.t })));
  }

  if (d.kind === 'withdrawn') {
    sec.append(h('p', { class:'hint msgnote',
      text:'The message that was here was removed because this lead opted out.' }));
    return sec;
  }

  // The server already sends structured fields - no markdown to parse here.
  if (d.link) {
    sec.append(h('a', {
      class:'btn btn-accent btn-sm', style:'margin-top:10px',
      text: d.channel === 'email' ? 'Open in Gmail' : 'Open profile',
      attrs:{ href:d.link, target:'_blank', rel:'noopener noreferrer' },
    }));
  }
  let shown = false;
  for (const [label, value] of [['To', d.to], ['Subject', d.subject], ['Body', d.body]]) {
    if (value == null) continue;
    sec.append(msgField(label, value));
    shown = true;
  }
  // A handful of drafts on disk predate the fenced-field format: the server
  // could not parse fields out of them and falls back to the raw file.
  if (!shown && d.markdown) sec.append(msgField('Raw file', d.markdown));
  if (d.canMarkSent) {
    sec.append(h('button', {
      class:'btn btn-accent btn-sm', style:'margin-top:10px', text:'Mark as sent',
      on:{ click: () => markSent(state.selected) },
    }));
  }
  return sec;
}

export function renderDetail() {
  const d = el('detail');
  const l = state.selected;
  if (!l) {
    d.replaceChildren(h('div', { class:'state' },
      h('h3', { text:'No lead selected' }),
      h('p', { text:'Pick a row to see why it scored the way it did, plus every contact channel on file.' })));
    return;
  }
  const pm = presenceMeta(l.website_kind);
  const sm = statusMeta(l.status);
  const reasons = splitNotes(l.notes);

  const head = h('div', { class:'detail-head' },
    h('div', { class:'row1' },
      h('h2', { text: l.name || '(unnamed)' }),
      l.tier ? h('span', { class:'badge tier tier-' + l.tier, text:l.tier }) : null,
      h('button', { class:'btn btn-ghost', text:'×', attrs:{ 'aria-label':'Close detail' }, on:{ click: closeDetail } })),
    h('div', { class:'sub', text:[l.category, l.area].filter(Boolean).join(' · ') }),
    h('div', { style:'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap' },
      h('span', { class:'badge st', style:'--sc:' + sm.color },
        h('span', { class:'tick', attrs:{ 'aria-hidden':'true' } }), h('span', { text: sm.label })),
      h('span', { class:'badge op-' + pm.band, text: pm.label })));

  const body = h('div', { class:'detail-body' });

  // Element.append() stringifies null (renders the literal text "null"),
  // unlike the h() helper's kids loop - guard the section that can be absent.
  body.append(renderMessageSection());
  const demoSection = renderDemoSection(l);
  if (demoSection) body.append(demoSection);

  body.append(h('section', { class:'dsec' },
    h('h3', { text:'Opportunity' }),
    h('p', { class:'hint', style:'font-size:12.5px;color:var(--text-2);margin:0', text: pm.say }),
    h('p', { class:'hint', style:'margin:6px 0 0', text: sm.hint })));

  if (reasons.length) {
    const list = h('div', { class:'reasons' });
    for (const r of reasons) {
      const tone = reasonTone(r);
      list.append(h('div', { class:'reason' + (tone ? ' ' + tone : '') },
        h('span', { class:'g', attrs:{ 'aria-hidden':'true' } }), h('span', { text: r })));
    }
    body.append(h('section', { class:'dsec' }, h('h3', { text:'Why it scored this way' }), list));
  }

  const score = num(l.osm_score);
  const kv = h('dl', { class:'kv' });
  const put = (k, v) => { if (v !== '' && v != null) { kv.append(h('dt', { text:k }), h('dd', { text:String(v) })); } };
  put('OSM score', l.osm_score || '–');
  put('Rating', l.rating || '–');
  put('Reviews', l.review_count || '–');
  put('Branches', l.chain_locations || '–');
  put('Demo', l.demo_slug || '–');
  const signals = h('section', { class:'dsec' }, h('h3', { text:'Signals' }), kv);
  if (l.osm_score) {
    signals.append(h('div', { class:'meter', attrs:{ role:'img', 'aria-label':'OSM score ' + score + ' of 40' } },
      h('i', { style:'width:' + Math.max(3, Math.min(100, (score / 40) * 100)) + '%' })));
  }
  body.append(signals);

  const chans = h('section', { class:'dsec' }, h('h3', { text:'Contact' }));
  const rows = [
    channelRow('email', l.email, l.email ? 'mailto:' + encodeURI(l.email) : null),
    channelRow('phone', l.phone, l.phone ? 'tel:' + l.phone.replace(/[^\d+]/g, '') : null),
    channelRow('instagram', l.instagram, socialUrl('instagram.com', l.instagram)),
    channelRow('facebook', l.facebook, socialUrl('facebook.com', l.facebook)),
  ].filter(Boolean);
  if (rows.length) rows.forEach((r) => chans.append(r));
  else chans.append(h('p', { class:'hint', style:'margin:0', text:'No channel on file yet — this one needs a manual pass.' }));
  body.append(chans);

  d.replaceChildren(head, body);
}
