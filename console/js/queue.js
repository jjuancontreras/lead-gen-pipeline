'use strict';
/**
 * The Work Queue page: every lead waiting on you, grouped by what you owe it.
 * Loads /api/queue, polls while a background job (record, harvest, verify)
 * runs, and sends each button through the queue routes.
 */
import { el, h } from './dom.js';
import { toast } from './toast.js';
import { GROUPS, ACTION_LABEL, CONFIRM, renderCard, showError } from './queue-cards.js';
import { openDialog, wireDialog } from './dialog.js';

const POLL_MS = 2500;
const page = { data: null, pollTimer: null, wasRunning: false, area: '' };

async function api(path, init) {
  const res = await fetch(path, init);
  let body = {};
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const err = new Error(body.error || `server returned ${res.status}`);
    err.fields = body.fields || [];
    throw err;
  }
  return body;
}
const post = (path, payload) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

/* ---- rendering ------------------------------------------------------------ */

function renderSetup(setup) {
  const notes = [];
  if (!setup.senderEmail) notes.push('SENDER_EMAIL is not set - pitch drafts will refuse until it is.');
  if (!setup.demoRoot) notes.push('DEMO_SITES_ROOT does not point at your demo folders - Build demo and Record will look in the wrong place.');
  if (!setup.portfolio) notes.push('PORTFOLIO_URLS is empty - first-contact emails go out without links to your past demos.');
  el('setup').hidden = notes.length === 0;
  el('setup').replaceChildren(h('strong', { text: 'Setup: ' }), ...notes.map((n) => h('span', { text: n })));
}

function renderJob(job) {
  const bar = el('jobbar');
  bar.hidden = !job.running;
  bar.replaceChildren(...(job.running ? [
    h('span', { class: 'dot pulse', attrs: { 'aria-hidden': 'true' } }),
    h('span', { text: `Working: ${job.label}. This page updates when it finishes.` }),
  ] : []));
  el('joberr').hidden = !job.lastError;
  el('joberr').textContent = job.lastError ? `The last job stopped: ${job.lastError}` : '';
}

function renderSummary(groups) {
  el('summary').replaceChildren(...GROUPS.map((g) => h('a', {
    class: `chip${groups[g.key].length ? '' : ' empty'}`, attrs: { href: `#g-${g.key}` },
  }, h('span', { text: g.title }), h('b', { text: String(groups[g.key].length) }))));
}

function verifyHeaderExtra(data) {
  if (!data.unverified) return null;
  const text = `${data.unverified} more not verified yet.`;
  if (!page.area) return h('p', { class: 'hint', text: `${text} Pick an area to verify them automatically.` });
  return h('p', { class: 'hint' }, h('span', { text: `${text} ` }),
    h('button', { class: 'btn btn-sm', text: 'Verify next 40 automatically',
      attrs: { type: 'button', disabled: data.job.running ? '' : null }, on: { click: runVerify } }));
}

function renderGroups(data) {
  el('groups').setAttribute('aria-busy', 'false');
  el('groups').replaceChildren(...GROUPS.map((g) => {
    const items = data.groups[g.key];
    return h('section', { class: 'panel qgroup', attrs: { id: `g-${g.key}`, 'aria-labelledby': `g-${g.key}-h` } },
      h('div', { class: 'qgroup-head' },
        h('h2', { attrs: { id: `g-${g.key}-h` } }, h('span', { text: g.title }), h('span', { class: 'count', text: String(items.length) })),
        h('p', { class: 'hint', text: g.hint })),
      g.key === 'verify' ? verifyHeaderExtra(data) : null,
      items.length
        ? h('div', { class: 'qcards' }, ...items.map((item) => renderCard(g.key, item, { ...HANDLERS, busy: data.job.running })))
        : h('p', { class: 'qempty', text: 'Nothing waiting here.' }));
  }));
}

function renderAreas(areas) {
  const sel = el('area');
  sel.replaceChildren(h('option', { text: 'All areas', attrs: { value: '' } }),
    ...areas.map((a) => h('option', { text: a.label, attrs: { value: a.key } })));
  sel.value = page.area;
}

async function load() {
  if (!page.data) {
    el('groups').setAttribute('aria-busy', 'true');
    el('groups').replaceChildren(h('div', { class: 'state' }, h('p', { class: 'sr', text: 'Loading the queue' }),
      ...[0, 1, 2].map(() => h('div', { class: 'skel', attrs: { style: 'margin:14px 0' } }))));
  }
  try {
    const data = await api(`/api/queue${page.area ? `?area=${encodeURIComponent(page.area)}` : ''}`);
    const firstLoad = !page.data;
    page.data = data;
    if (firstLoad) renderAreas(data.areas);
    renderSetup(data.setup);
    renderJob(data.job);
    renderSummary(data.groups);
    renderGroups(data);
    if (page.wasRunning && !data.job.running) {
      toast(data.job.lastError ? 'The job stopped with an error' : (data.job.lastResult || 'Job finished'), data.job.lastError ? 'err' : 'ok');
    }
    page.wasRunning = data.job.running;
    clearTimeout(page.pollTimer);
    if (data.job.running) page.pollTimer = setTimeout(load, POLL_MS);
  } catch (err) {
    if (page.data) { toast(`Could not refresh: ${err.message}`, 'err'); return; }
    el('groups').setAttribute('aria-busy', 'false');
    el('groups').replaceChildren(h('div', { class: 'state', attrs: { role: 'alert' } },
      h('h3', { text: 'Could not load the Work Queue' }),
      h('p', { text: err.message }),
      h('button', { class: 'btn', text: 'Try again', attrs: { type: 'button' }, on: { click: load } })));
  }
}

/* ---- actions --------------------------------------------------------------- */

async function act(lead, action, opts = {}) {
  if (CONFIRM.has(action) && !window.confirm(`${ACTION_LABEL[action]}: ${lead.name}?`)) return;
  try {
    await post('/api/queue/transition', { lead_id: lead.lead_id, action, ...(opts.url ? { url: opts.url } : {}) });
    toast(`${lead.name}: ${ACTION_LABEL[action]}`, 'ok');
    await load();
  } catch (err) {
    if (opts.err) { showError(opts.input, opts.err, err.message); opts.input?.focus(); }
    else toast(err.message, 'err');
  }
}

const CONTACT_FIELDS = ['website_url', 'email', 'phone', 'instagram', 'facebook', 'tiktok'];
/** The same rules the server applies (manual-verify.ts), checked before sending. */
function verifyProblems(a) {
  const fields = {};
  if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) fields.email = 'not a valid email address';
  if (a.rating && !(/^\d(\.\d)?$/.test(a.rating) && Number(a.rating) <= 5)) fields.rating = 'rating is 0 to 5, like 4.6';
  if (a.review_count && !/^\d{1,9}$/.test(a.review_count)) fields.review_count = 'a whole number';
  const nothing = !CONTACT_FIELDS.some((k) => a[k]);
  return { fields, form: nothing ? 'enter a website or at least one contact - or Disqualify the lead' : '' };
}

const errFor = (input) => document.getElementById(`${input.id}-err`);

async function verify(lead, answers, form, formErr) {
  for (const input of form.querySelectorAll('input')) showError(input, errFor(input), '');
  showError(null, formErr, '');
  const problems = verifyProblems(answers);
  const badKeys = Object.keys(problems.fields);
  if (badKeys.length || problems.form) {
    for (const k of badKeys) showError(form.elements[k], errFor(form.elements[k]), problems.fields[k]);
    showError(null, formErr, problems.form || 'fix the highlighted fields');
    (badKeys.length ? form.elements[badKeys[0]] : form.elements.website_url).focus();
    return;
  }
  try {
    await post('/api/queue/verify', { lead_id: lead.lead_id, answers });
    toast(`${lead.name}: verified`, 'ok');
    await load();
  } catch (err) {
    const bad = (err.fields || []).map((f) => form.elements[f]).filter(Boolean);
    for (const input of bad) showError(input, errFor(input), 'Check this field');
    showError(null, formErr, err.message);
    (bad[0] || form.elements.website_url).focus();
  }
}

async function build(lead, from) {
  try {
    const { kit } = await post('/api/queue/build', { lead_id: lead.lead_id });
    await load();
    openDialog(`Demo kit - ${lead.name}`, h('div', { class: 'kit' },
      h('p', { text: kit.reused ? 'The demo folder already existed, so it was adopted as it is.' : 'The demo folder is ready.' }),
      h('dl', { class: 'qc-facts' },
        h('dt', { text: 'Folder' }), h('dd', {}, h('code', { text: kit.path })),
        h('dt', { text: 'Dev port' }), h('dd', { text: String(kit.port || 'not registered') }),
        h('dt', { text: 'Build prompt' }), h('dd', {}, h('code', { text: kit.buildPrompt || 'none found' }))),
      h('p', { text: 'Next: open the build prompt in Claude Code and run /demo-site-build. Deploy it, then come back and Mark built.' })), from);
  } catch (err) { toast(err.message, 'err'); }
}

async function startJob(path, lead, what) {
  try {
    await post(path, { lead_id: lead.lead_id });
    toast(`${what} started for ${lead.name}`, 'ok');
    page.wasRunning = true;
  } catch (err) { toast(err.message, 'err'); }
  await load();
}
const record = (lead) => startJob('/api/queue/record', lead, 'Recording');
const harvest = (lead) => startJob('/api/queue/harvest', lead, 'Photo harvest');

async function runVerify() {
  if (!window.confirm('Verify the next 40 leads on Google Maps? This drives a browser for about 10 minutes.')) return;
  try {
    await post('/api/queue/verify-run', { area: page.area });
    page.wasRunning = true;
  } catch (err) { toast(err.message, 'err'); }
  await load();
}

async function pitch(lead, from) {
  try {
    const { draft } = await post('/api/queue/pitch', { lead_id: lead.lead_id });
    await load();
    openDialog(`Pitch - ${lead.name}`, h('div', { class: 'mail' },
      h('p', {}, h('span', { class: 'badge send-off', text: 'Draft - not sent' })),
      h('dl', {}, h('dt', { text: 'To' }), h('dd', { text: draft.to }), h('dt', { text: 'Subject' }), h('dd', { text: draft.subject })),
      h('pre', { text: draft.body, attrs: { tabindex: '0', 'aria-label': 'Email body' } }),
      h('p', { class: 'hint' }, h('span', { text: 'Saved to ' }), h('code', { text: draft.path }),
        h('span', { text: '. Send it from your mailbox, then click Mark pitch sent.' }))), from);
  } catch (err) { toast(err.message, 'err'); }
}

async function sent(lead) {
  if (!window.confirm(`Mark as sent: ${lead.name}? This starts the follow-up clock.`)) return;
  try {
    await post('/api/sent', { lead_id: lead.lead_id });
    toast(`${lead.name}: marked sent`, 'ok');
    await load();
  } catch (err) { toast(err.message, 'err'); }
}

function playRecording(lead, from) {
  const base = `/demo-files/${encodeURIComponent(lead.slug)}/public/demo/${encodeURIComponent(lead.slug)}`;
  openDialog(`Recording - ${lead.name}`, h('div', {},
    h('video', { class: 'vid', attrs: { src: `${base}-16x9.mp4`, controls: '', preload: 'metadata',
      'aria-label': `Walkthrough recording of the demo for ${lead.name}` } }),
    h('p', { class: 'hint', text: 'Silent 16:9 take for email. The 9:16 take and the hero image are in the same folder.' })), from);
}

/* ---- boot ------------------------------------------------------------------ */

// Declared after every handler it names: `record` and `harvest` are consts,
// and naming them any earlier is a temporal-dead-zone ReferenceError.
const HANDLERS = { act, verify, build, record, harvest, pitch, sent, playRecording };

el('area').addEventListener('change', (e) => { page.area = e.target.value; load(); });
el('refresh').addEventListener('click', load);
wireDialog();
load();
