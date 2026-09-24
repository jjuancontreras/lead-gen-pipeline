'use strict';
/**
 * The preview dialog: the generated site, the walkthrough video and the
 * email draft for one lead. A modal dialog with a focus trap, arrow-key tabs
 * and Escape to close; focus returns to the button that opened it.
 */
import { el, h } from './dom.js';

let current = null;   // the row being previewed
let opener = null;    // the element to give focus back to
let tab = 'site';

const tabs = () => Array.from(document.querySelectorAll('#preview [role="tab"]'));

function notYet(what, row, stage) {
  return h('div', { class: 'state' },
    h('h3', { text: `No ${what} yet` }),
    h('p', { text: `The ${stage} stage for ${row.name} is ${row.stages[stage].status}.` }));
}

function paneFor(row) {
  if (tab === 'site') {
    if (!row.preview.siteUrl) return notYet('site', row, 'site');
    return h('div', {},
      // sandbox before src: it must be in place when the navigation starts.
      // No loading="lazy" - the sheet is display:none when this is built.
      h('iframe', { class: 'frame', attrs: {
        title: `Demo site for ${row.name}`,
        sandbox: 'allow-popups allow-popups-to-escape-sandbox',
        src: row.preview.siteUrl,
      } }),
      h('div', { class: 'links' },
        h('a', { text: 'Open the site in a new tab', attrs: { href: row.preview.siteUrl, target: '_blank', rel: 'noopener' } })));
  }
  if (tab === 'video') {
    if (!row.preview.videoUrl) return notYet('video', row, 'video');
    return h('div', {},
      h('video', { class: 'vid', attrs: {
        src: row.preview.videoUrl, controls: '', preload: 'metadata',
        'aria-label': `Walkthrough video of the demo site for ${row.name}`,
      } }),
      h('p', { class: 'hint', text: 'Silent screen recording of the demo site.' }));
  }
  const mail = row.preview.email;
  if (!mail) return notYet('email draft', row, 'email');
  return h('div', { class: 'mail' },
    h('p', {}, h('span', { class: `badge ${mail.sent ? 'pill-failed' : 'send-off'}`,
      text: mail.sent ? 'Recorded as sent' : 'Draft - not sent' })),
    h('dl', {},
      h('dt', { text: 'To' }), h('dd', { text: mail.to }),
      h('dt', { text: 'Subject' }), h('dd', { text: mail.subject })),
    h('pre', { text: mail.body, attrs: { tabindex: '0', 'aria-label': 'Email body' } }));
}

function renderPane() {
  if (!current) return;
  for (const t of tabs()) {
    const on = t.dataset.tab === tab;
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
  }
  el('pane').setAttribute('aria-labelledby', `tab-${tab}`);
  el('pane').replaceChildren(paneFor(current));
}

export function openPreview(row, from) {
  current = row;
  opener = from || null;
  tab = row.preview.siteUrl ? 'site' : row.preview.videoUrl ? 'video' : 'email';
  el('preview-title').textContent = `Preview - ${row.name}`;
  el('backdrop').hidden = false;
  el('preview').hidden = false;
  requestAnimationFrame(() => { el('backdrop').classList.add('on'); el('preview').classList.add('on'); });
  renderPane();
  el('closepreview').focus();
}

export function closePreview() {
  if (!current) return;
  current = null;
  el('preview').classList.remove('on');
  el('backdrop').classList.remove('on');
  el('preview').hidden = true;
  el('backdrop').hidden = true;
  el('pane').replaceChildren();
  if (opener && document.contains(opener)) opener.focus();
  opener = null;
}

export const isPreviewOpen = () => current !== null;

/** Keep Tab inside the dialog. */
function trapFocus(e) {
  const focusable = Array.from(el('preview').querySelectorAll(
    'button:not([disabled]), [href], iframe, video, [tabindex]:not([tabindex="-1"])'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function wirePreview() {
  el('closepreview').addEventListener('click', closePreview);
  el('backdrop').addEventListener('click', closePreview);
  for (const t of tabs()) {
    t.addEventListener('click', () => { tab = t.dataset.tab; renderPane(); });
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const all = tabs();
      const i = all.indexOf(t) + (e.key === 'ArrowRight' ? 1 : -1);
      const next = all[(i + all.length) % all.length];
      tab = next.dataset.tab;
      renderPane();
      next.focus();
    });
  }
  el('preview').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePreview(); }
    if (e.key === 'Tab') trapFocus(e);
  });
}
