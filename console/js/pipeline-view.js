'use strict';
/**
 * Rendering for the demo-pipeline dashboard. Pure DOM building with h():
 * every value from the API goes in through textContent (see dom.js).
 */
import { h } from './dom.js';

export const STAGES = ['find', 'site', 'video', 'email'];
const LABEL = { find: 'Find', site: 'Site', video: 'Video', email: 'Email' };
/* Status is never colour alone: each pill has an icon and a word. */
const PILL = {
  done: { ic: '✓', text: 'Done' },
  failed: { ic: '!', text: 'Failed' },
  running: { ic: '…', text: 'Running' },
  pending: { ic: '–', text: 'Pending' },
};

export function pill(status) {
  const p = PILL[status] || PILL.pending;
  return h('span', { class: `pill pill-${status}` },
    h('span', { class: 'ic', text: p.ic, attrs: { 'aria-hidden': 'true' } }),
    h('span', { text: p.text }));
}

export function renderCards(root, counts, total) {
  root.replaceChildren(...STAGES.map((s) => {
    const c = counts[s] || { done: 0, failed: 0, running: 0, pending: 0 };
    return h('div', { class: 'card' },
      h('h3', { text: LABEL[s] }),
      h('div', { class: 'big', text: String(c.done) }, h('small', { text: `of ${total} done` })),
      h('div', { class: 'split' },
        h('span', { class: 'f', text: `${c.failed} failed` }),
        h('span', { class: 'r', text: `${c.running} running` }),
        h('span', { text: `${c.pending} pending` })));
  }));
}

export function renderLoading(root) {
  root.setAttribute('aria-busy', 'true');
  root.replaceChildren(h('div', { class: 'state' },
    h('p', { class: 'sr', text: 'Loading leads' }),
    ...[0, 1, 2].map(() => h('div', { class: 'skel', attrs: { style: 'margin:14px 0' } }))));
}

export function renderError(root, message, onRetry) {
  root.setAttribute('aria-busy', 'false');
  root.replaceChildren(h('div', { class: 'state', attrs: { role: 'alert' } },
    h('h3', { text: 'Could not load the pipeline' }),
    h('p', { text: message }),
    h('button', { class: 'btn', text: 'Try again', attrs: { type: 'button' }, on: { click: onRetry } })));
}

export function renderEmpty(root) {
  root.setAttribute('aria-busy', 'false');
  root.replaceChildren(h('div', { class: 'state' },
    h('h3', { text: 'No leads have been through the demo pipeline yet' }),
    h('p', { text: 'Build demos for an area above, or run the fixtures from a terminal:' }),
    h('p', {}, h('code', { text: 'npm run pipeline -- --fixtures test/fixtures/businesses.json' }))));
}

function stageCell(row, stage, { busy, onRetry }) {
  const cell = row.stages[stage];
  const kids = [pill(cell.status)];
  if (cell.status === 'failed') {
    kids.push(h('span', { class: 'why', text: cell.error || 'failed with no message' }));
    kids.push(h('button', {
      class: 'btn btn-sm', text: 'Retry',
      attrs: { type: 'button', 'aria-label': `Retry ${stage} for ${row.name}`, ...(busy ? { disabled: '' } : {}) },
      on: { click: () => onRetry(row, stage) },
    }));
  }
  if (cell.attempts > 1) kids.push(h('span', { class: 'hint', text: `${cell.attempts} attempts` }));
  return h('td', { attrs: { 'data-label': LABEL[stage] } }, h('div', { class: 'cell' }, ...kids));
}

export function renderBoard(root, rows, handlers) {
  root.setAttribute('aria-busy', 'false');
  const head = h('tr', {},
    h('th', { text: 'Business', attrs: { scope: 'col' } }),
    ...STAGES.map((s) => h('th', { text: LABEL[s], attrs: { scope: 'col' } })),
    h('th', { attrs: { scope: 'col' } }, h('span', { class: 'sr', text: 'Actions' })));

  const body = rows.map((row) => {
    const hasPreview = Boolean(row.preview.siteUrl || row.preview.videoUrl || row.preview.email);
    return h('tr', { attrs: { 'data-lead': row.lead_id } },
      h('td', { class: 'c-biz' }, h('div', { class: 'biz' },
        h('span', { class: 'nm', text: row.name }),
        h('span', { class: 'meta', text: [row.category, row.area].filter(Boolean).join(' - ') }))),
      ...STAGES.map((s) => stageCell(row, s, handlers)),
      h('td', { attrs: { 'data-label': 'Preview' } }, h('button', {
        class: 'btn btn-sm', text: 'Preview',
        attrs: { type: 'button', 'aria-label': `Preview site, video and email for ${row.name}`,
          ...(hasPreview ? {} : { disabled: '' }) },
        on: { click: (e) => handlers.onPreview(row, e.currentTarget) },
      })));
  });

  root.replaceChildren(h('table', { class: 'board' },
    h('caption', { class: 'sr', text: 'Each lead and the status of every pipeline stage' }),
    h('thead', {}, head),
    h('tbody', {}, ...body)));
}
