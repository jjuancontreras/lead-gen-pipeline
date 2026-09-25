'use strict';
/**
 * Work Queue cards. Pure DOM building with h(): every value from the API goes
 * in through textContent or an attribute (see dom.js), never innerHTML.
 *
 * `on` is the page's handler set: act, verify, build, record, harvest, pitch,
 * sent, playRecording - plus `busy`, true while a background job runs. Each
 * handler owns its request, its errors and the reload; this file only draws
 * and wires.
 */
import { h } from './dom.js';
import { statusMeta } from './vocabulary.js';

export const GROUPS = [
  { key: 'verify', title: 'Verify by hand', hint: 'Automatic verification could not settle these. Look them up, record what you find.' },
  { key: 'choose', title: 'Choose demos', hint: 'Verified tier-A leads. A full demo is 3-5 hours of your time - pick the ones worth it.' },
  { key: 'build', title: 'Build', hint: 'Demos you picked. Build demo scaffolds the folder; then /demo-site-build, deploy, Mark built.' },
  { key: 'record', title: 'Record', hint: 'Deployed demos without a walkthrough yet. Record, redeploy so the video is live, set its link.' },
  { key: 'pitch', title: 'Pitch', hint: 'Demo and video are live. Draft the pitch, send it yourself, then mark it sent.' },
  { key: 'send', title: 'Drafts to send', hint: 'Written by the campaign and waiting for you to press Send.' },
  { key: 'followup', title: 'Follow-ups due', hint: 'The 3/7/14 clock says it is time to touch these again.' },
  { key: 'conversations', title: 'Conversations', hint: 'Waiting on a reply, or talking. Log what happens.' },
];

export const ACTION_LABEL = {
  queue_demo: 'Build a demo for this', unqueue: 'Unqueue', mark_built: 'Mark built', set_video: 'Set video link',
  pitch_sent: 'Mark pitch sent', nudged: 'Mark nudged', replied: 'Replied', meeting: 'Meeting booked',
  won: 'Won', lost: 'Lost', nurture: 'Park (nurture)', disqualify: 'Disqualify',
};
/** Actions with their own form (a URL to enter), not a plain button. */
const URL_ACTIONS = new Set(['mark_built', 'set_video']);
/** Actions that record something you cannot quietly take back. */
export const CONFIRM = new Set(['pitch_sent', 'won', 'lost', 'disqualify']);

const idFor = (lead, part) => `${lead.lead_id.replace(/[^a-z0-9]+/gi, '-')}-${part}`;
const btn = (text, attrs, onClick, cls = 'btn btn-sm') =>
  h('button', { class: cls, text, attrs: { type: 'button', ...attrs }, on: { click: onClick } });

function header(lead) {
  const meta = statusMeta(lead.status);
  const facts = [lead.category, lead.areaLabel, lead.tier ? `tier ${lead.tier}` : '', lead.osm_score ? `score ${lead.osm_score}` : '']
    .filter(Boolean).join(' - ');
  return h('div', { class: 'qc-head' },
    h('div', { class: 'biz' },
      h('h3', { class: 'nm', text: lead.name }),
      h('span', { class: 'meta', text: facts })),
    h('span', { class: 'badge st', attrs: { style: `--sc:${meta.color}` } },
      h('span', { class: 'tick', attrs: { 'aria-hidden': 'true' } }), h('span', { text: meta.label })));
}

function facts(lead) {
  const rows = [
    ['Email', lead.email], ['Phone', lead.phone], ['Instagram', lead.instagram], ['Facebook', lead.facebook],
    ['Demo', lead.demo_url, true], ['Video', lead.video_url, true], ['Next touch', lead.next_action_date],
  ].filter(([, v]) => v);
  if (!rows.length) return null;
  return h('dl', { class: 'qc-facts' }, ...rows.flatMap(([k, v, link]) => [
    h('dt', { text: k }),
    h('dd', {}, link ? h('a', { text: v, attrs: { href: v, target: '_blank', rel: 'noopener' } }) : h('span', { text: v })),
  ]));
}

/** A labelled URL field with its own error line - Mark built, Set video link. */
function urlForm(lead, action, on, prefill = '') {
  const inputId = idFor(lead, `${action}-url`);
  const errId = `${inputId}-err`;
  const input = h('input', { class: 'inp', attrs: {
    id: inputId, type: 'url', inputmode: 'url', required: '', value: prefill,
    placeholder: 'https://', 'aria-describedby': errId, autocomplete: 'off',
  } });
  const err = h('p', { class: 'err', attrs: { id: errId, hidden: '' } });
  const label = action === 'mark_built' ? 'Live demo URL' : 'Hosted video link';
  const form = h('form', { class: 'qc-form', attrs: { novalidate: '' } },
    h('label', { text: label, attrs: { for: inputId } }),
    h('div', { class: 'qc-inline' }, input, h('button', { class: 'btn btn-sm btn-accent', text: ACTION_LABEL[action], attrs: { type: 'submit' } })),
    err);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!/^https?:\/\/\S+\.\S+/.test(value)) {
      showError(input, err, 'Enter the full address, starting with https://');
      input.focus();
      return;
    }
    on.act(lead, action, { url: value, input, err });
  });
  return form;
}

export function showError(input, err, message) {
  input?.setAttribute('aria-invalid', message ? 'true' : 'false');
  err.hidden = !message;
  err.textContent = message || '';
}

const VERIFY_FIELDS = [
  ['website_url', 'Website (or their social page)', 'url'], ['email', 'Email', 'email'], ['phone', 'Phone', 'tel'],
  ['instagram', 'Instagram', 'text'], ['facebook', 'Facebook', 'text'], ['tiktok', 'TikTok', 'text'],
  ['rating', 'Google rating', 'text'], ['review_count', 'Review count', 'text'], ['notes', 'Notes', 'text'],
];

/** The hand-verification form, hidden until asked for. */
function verifyForm(lead, on) {
  const formId = idFor(lead, 'verify');
  const fields = VERIFY_FIELDS.map(([key, label, type]) => {
    const id = `${formId}-${key}`;
    return h('div', { class: 'fld' },
      h('label', { text: label, attrs: { for: id } }),
      h('input', { class: 'inp', attrs: { id, name: key, type, autocomplete: 'off', 'aria-describedby': `${id}-err` } }),
      h('p', { class: 'err', attrs: { id: `${id}-err`, hidden: '' } }));
  });
  const formErr = h('p', { class: 'err', attrs: { id: `${formId}-err`, hidden: '', role: 'alert' } });
  const form = h('form', { class: 'qc-verify', attrs: { id: formId, novalidate: '', hidden: '' } },
    h('div', { class: 'qc-grid' }, ...fields), formErr,
    h('button', { class: 'btn btn-accent btn-sm', text: 'Save verification', attrs: { type: 'submit' } }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const answers = Object.fromEntries(VERIFY_FIELDS.map(([k]) => [k, form.elements[k].value.trim()]));
    on.verify(lead, answers, form, formErr);
  });
  const toggle = btn('Verify', { 'aria-expanded': 'false', 'aria-controls': formId }, () => {
    const open = form.hidden;
    form.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) form.elements.website_url.focus();
  }, 'btn btn-sm btn-accent');
  return { toggle, form };
}

function linkRow(links) {
  return h('div', { class: 'links' }, ...[['Google Maps', links.maps], ['Web search', links.web],
    ['Facebook', links.facebook], ['Instagram', links.instagram]]
    .map(([t, href]) => h('a', { text: t, attrs: { href, target: '_blank', rel: 'noopener' } })));
}

/** The buttons and forms a card shows, by group. */
function controls(group, item, on) {
  const { lead } = item;
  const out = [];
  const plain = item.actions.filter((a) => !URL_ACTIONS.has(a));
  // Where the card has its own primary control (Verify, Build demo), the
  // status buttons are all secondary; elsewhere the first one leads.
  const ownPrimary = group === 'verify' || group === 'build';
  const buttons = plain.map((a, i) => btn(ACTION_LABEL[a],
    { 'aria-label': `${ACTION_LABEL[a]}: ${lead.name}` },
    (e) => on.act(lead, a, { from: e.currentTarget }),
    i === 0 && !ownPrimary ? 'btn btn-sm btn-accent' : 'btn btn-sm'));

  if (group === 'verify') {
    const v = verifyForm(lead, on);
    out.push(linkRow(lead.links), h('div', { class: 'qc-actions' }, v.toggle, ...buttons), v.form);
    return out;
  }
  if (group === 'build' && lead.status === 'demo_queued') {
    out.push(h('div', { class: 'qc-actions' },
      btn('Build demo', { 'aria-label': `Build demo: ${lead.name}` }, (e) => on.build(lead, e.currentTarget), 'btn btn-sm btn-accent'),
      ...buttons));
    return out;
  }
  if (group === 'build') {
    if (lead.instagram) {
      out.push(h('div', { class: 'qc-actions' },
        btn('Harvest Instagram photos', { 'aria-label': `Harvest Instagram photos: ${lead.name}`, ...(on.busy ? { disabled: '' } : {}) }, () => on.harvest(lead))));
    }
    out.push(urlForm(lead, 'mark_built', on));
    return out;
  }
  if (group === 'record') {
    const row = [btn(lead.recorded ? 'Record again' : 'Record', { 'aria-label': `Record the live demo: ${lead.name}`, ...(on.busy ? { disabled: '' } : {}) },
      () => on.record(lead), lead.recorded ? 'btn btn-sm' : 'btn btn-sm btn-accent')];
    // While a job runs, a take may be half-written by ffmpeg: nothing to watch yet.
    if (lead.recorded && !on.busy) {
      row.push(btn('Watch recording', { 'aria-label': `Watch the recording: ${lead.name}` }, (e) => on.playRecording(lead, e.currentTarget)));
    }
    out.push(h('div', { class: 'qc-actions' }, ...row), urlForm(lead, 'set_video', on, lead.suggestedVideoUrl));
    return out;
  }
  if (group === 'pitch') {
    const refusal = lead.pitch?.refusal;
    out.push(h('div', { class: 'qc-actions' },
      btn(lead.pitch?.drafted ? 'Show pitch draft' : 'Draft pitch',
        { 'aria-label': `Draft the pitch: ${lead.name}`, ...(refusal ? { disabled: '' } : {}) },
        (e) => on.pitch(lead, e.currentTarget), 'btn btn-sm btn-accent'),
      ...buttons.map((b) => { if (!lead.pitch?.drafted) b.setAttribute('disabled', ''); return b; })));
    if (refusal) out.push(h('p', { class: 'err', text: refusal }));
    else if (!lead.pitch?.drafted) out.push(h('p', { class: 'hint', text: 'Draft it first; Mark pitch sent unlocks once a draft exists.' }));
    return out;
  }
  if (group === 'send') {
    out.push(h('div', { class: 'qc-actions' },
      btn('Mark as sent', { 'aria-label': `Mark as sent: ${lead.name}` }, (e) => on.sent(lead, e.currentTarget), 'btn btn-sm btn-accent')));
    return out;
  }
  out.push(h('div', { class: 'qc-actions' }, ...buttons));
  return out;
}

export function renderCard(group, item, on) {
  const { lead } = item;
  return h('article', { class: 'qc', attrs: { 'data-lead': lead.lead_id, 'aria-label': lead.name } },
    header(lead),
    item.note ? h('p', { class: 'qc-note', text: item.note }) : null,
    facts(lead),
    ...controls(group, item, on));
}
