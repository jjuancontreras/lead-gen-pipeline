'use strict';
/**
 * Demo-pipeline dashboard: loads /api/pipeline, polls while a job runs,
 * validates the run form, and retries failed stages.
 */
import { el, h } from './dom.js';
import { toast } from './toast.js';
import {
  renderCards, renderBoard, renderLoading, renderError, renderEmpty,
} from './pipeline-view.js';
import { wirePreview, openPreview } from './pipeline-preview.js';

// Each poll is cheap (state file + a cached store read), but the store may be
// the Google Sheet with a 60-reads-a-minute quota; 2.5 s keeps well inside it.
const POLL_MS = 2500;
const page = { data: null, pollTimer: null, wasRunning: false };

async function api(path, init) {
  const res = await fetch(path, init);
  let body = {};
  try { body = await res.json(); } catch { /* an empty or non-JSON body */ }
  if (!res.ok) {
    const err = new Error(body.error || `server returned ${res.status}`);
    err.status = res.status;
    err.fields = body.fields || [];
    throw err;
  }
  return body;
}

const post = (path, payload) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

/* ---- job status ------------------------------------------------------------ */

function renderJob(job) {
  const bar = el('jobbar');
  if (job.running) {
    bar.hidden = false;
    bar.replaceChildren(h('span', { class: 'dot pulse', attrs: { 'aria-hidden': 'true' } }),
      h('span', { text: `Working: ${job.label}. This page updates as each stage finishes.` }));
  } else {
    bar.hidden = true;
    bar.replaceChildren();
  }
  const err = el('joberr');
  err.hidden = !job.lastError;
  err.textContent = job.lastError ? `The last job stopped with an error: ${job.lastError}` : '';
  el('runbtn').disabled = job.running;
}

function schedulePoll(running) {
  clearTimeout(page.pollTimer);
  if (running) page.pollTimer = setTimeout(load, POLL_MS);
}

/* ---- load + render ------------------------------------------------------- */

/** Area options, each saying how many leads are ready - kept current on every load. */
function renderAreas(areas) {
  const select = el('area');
  const chosen = select.value;
  select.replaceChildren(h('option', { text: 'Choose an area', attrs: { value: '' } }),
    ...areas.map((a) => h('option', { text: `${a.label} (${a.ready} ready)`, attrs: { value: a.key } })));
  select.value = areas.some((a) => a.key === chosen) ? chosen : '';
}

const readyIn = (key) => (page.data?.areas.find((a) => a.key === key)?.ready ?? 0);

async function load() {
  const body = el('boardbody');
  if (!page.data) renderLoading(body);
  try {
    const data = await api('/api/pipeline');
    page.data = data;
    renderAreas(data.areas);
    el('limit').max = String(data.maxRunLimit);
    el('sending').textContent = data.sending ? 'SENDING IS ON' : 'Sending off - drafts only';
    renderCards(el('cards'), data.counts, data.rows.length);
    renderJob(data.job);
    if (data.rows.length === 0) renderEmpty(body);
    else renderBoard(body, data.rows, { busy: data.job.running, onRetry: retry, onPreview: openPreview });

    if (page.wasRunning && !data.job.running) {
      toast(data.job.lastError ? 'The job stopped with an error' : 'Job finished', data.job.lastError ? 'err' : 'ok');
    }
    page.wasRunning = data.job.running;
    schedulePoll(data.job.running);
  } catch (err) {
    if (page.data) {
      toast(`Could not refresh: ${err.message}`, 'err');
      schedulePoll(page.wasRunning);
    } else {
      renderError(body, err.message, load);
    }
  }
}

/* ---- retry --------------------------------------------------------------- */

async function retry(row, stage) {
  try {
    await post('/api/pipeline/retry', { lead_id: row.lead_id, stage });
    toast(`Retrying ${stage} for ${row.name}`, 'ok');
    page.wasRunning = true;
  } catch (err) {
    toast(err.message, 'err');
  }
  await load();
}

/* ---- run form -------------------------------------------------------------- */

function setFieldError(id, message) {
  const input = el(id);
  const msg = el(`${id}-err`);
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  msg.hidden = !message;
  msg.textContent = message || '';
}

/** Client-side check; the server validates the same rules again. */
function validateRun(area, limitRaw, max) {
  const errors = {};
  if (!area) errors.area = 'Choose an area.';
  else if (readyIn(area) === 0) errors.area = 'No leads in this area are ready for a demo yet - run a campaign for it first.';
  const n = Number(limitRaw);
  if (limitRaw === '' || !Number.isInteger(n)) errors.limit = 'Enter a whole number.';
  else if (n < 1 || n > max) errors.limit = `Enter a number from 1 to ${max}.`;
  return errors;
}

async function onRun(e) {
  e.preventDefault();
  const area = el('area').value;
  const limitRaw = el('limit').value.trim();
  const errors = validateRun(area, limitRaw, Number(el('limit').max) || 10);
  setFieldError('area', errors.area);
  setFieldError('limit', errors.limit);
  const firstBad = ['area', 'limit'].find((f) => errors[f]);
  if (firstBad) { el(firstBad).focus(); return; }

  el('runbtn').disabled = true;
  try {
    await post('/api/pipeline/run', { area, limit: Number(limitRaw) });
    toast('Building demos - this page will update as they finish', 'ok');
    page.wasRunning = true;
  } catch (err) {
    const field = (err.fields || []).find((f) => f === 'area' || f === 'limit');
    if (field) { setFieldError(field, err.message); el(field).focus(); }
    else toast(err.message, 'err');
  }
  await load();
}

/* ---- boot ------------------------------------------------------------------ */

el('runform').addEventListener('submit', onRun);
el('area').addEventListener('change', () => setFieldError('area', ''));
el('limit').addEventListener('input', () => setFieldError('limit', ''));
el('refresh').addEventListener('click', load);
wirePreview();
load();
