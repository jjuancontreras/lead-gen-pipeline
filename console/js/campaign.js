'use strict';
import { el, h } from './dom.js';
import { toast } from './toast.js';
import { state } from './state.js';
import { loadLeads } from './data.js';

/* ---- map + areas ---------------------------------------------------------
   Everything about the "Areas & campaigns" sheet: drawing an area, saving
   it, running a campaign against it, and streaming the run's output. Fairly
   self-contained - the only thing outside this module it touches is
   loadLeads(), called once a run finishes.
--------------------------------------------------------------------------- */

// Metro Manila. Hand-writing bbox coordinates is error-prone and tedious;
// drawing the rectangle removes that step entirely.
const map = L.map('map', { zoomControl: true }).setView([14.63, 121.06], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const existing = new L.FeatureGroup().addTo(map);  // areas already saved
const drawn = new L.FeatureGroup().addTo(map);     // the rectangle being drawn
map.addControl(new L.Control.Draw({
  edit: { featureGroup: drawn },
  draw: { polyline:false, polygon:false, circle:false, marker:false, circlemarker:false, rectangle:true }
}));

let bbox = null;

export function setBboxReadout() {
  const out = el('bboxout');
  if (!bbox) {
    out.textContent = 'Draw a rectangle on the map to set the bounding box.';
  } else {
    out.textContent = 'bbox [S, W, N, E] = ' + bbox.join(', ');
  }
  el('cleardraw').disabled = !bbox;
  syncSaveButton();
}

map.on(L.Draw.Event.CREATED, (e) => {
  drawn.clearLayers();
  drawn.addLayer(e.layer);
  const b = e.layer.getBounds();
  // Overpass order: south, west, north, east.
  bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((n) => +n.toFixed(5));
  hideAreaAlert();
  setBboxReadout();
});

el('cleardraw').onclick = () => { drawn.clearLayers(); bbox = null; setBboxReadout(); };

const kebab = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

// Typing a label offers a key, until the key field is touched by hand.
let keyTouched = false;
el('key').addEventListener('input', () => {
  keyTouched = el('key').value.trim() !== '';
  validateKey();
});
el('label').addEventListener('input', () => {
  if (!keyTouched) el('key').value = kebab(el('label').value.trim()).slice(0, 40);
  validateKey();
});

function validateKey() {
  const v = el('key').value.trim();
  const bad = v !== '' && !KEY_RE.test(v);
  el('key').classList.toggle('bad', bad);
  el('keyhint').textContent = bad
    ? 'Not kebab-case yet. Use a-z, 0-9 and hyphens; start with a letter or digit.'
    : 'Key must be kebab-case: a-z 0-9 -, starting with a letter or digit.';
  syncSaveButton();
}

function syncSaveButton() {
  const v = el('key').value.trim();
  el('save').disabled = !bbox || !KEY_RE.test(v);
}

function showAreaAlert(msg, ok) {
  const a = el('areaalert');
  a.className = 'alert' + (ok ? ' ok' : '');
  a.replaceChildren(h('span', { text: msg }));
  a.hidden = false;
}
function hideAreaAlert() { el('areaalert').hidden = true; }

el('save').onclick = async () => {
  const key = el('key').value.trim().toLowerCase();
  const label = el('label').value.trim();
  if (!bbox || !KEY_RE.test(key)) return;
  const btn = el('save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/areas', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ key, label, bbox }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 400 = bad key or bad bbox, 409 = duplicate. Say which, in place.
      const why = res.status === 409 ? 'That key is taken' : 'Rejected';
      showAreaAlert(why + ' (' + res.status + '): ' + (out.error || 'unknown error'), false);
      if (res.status === 409) el('key').focus();
      return;
    }
    el('key').value = ''; el('label').value = ''; keyTouched = false;
    drawn.clearLayers(); bbox = null;
    setBboxReadout(); validateKey();
    showAreaAlert('Saved "' + (out.key || key) + '". Draw another to add more.', true);
    toast('Area saved', 'ok');
    loadAreas();
  } catch (err) {
    showAreaAlert('Network error: ' + (err.message || 'request failed'), false);
  } finally {
    btn.textContent = 'Save area';
    syncSaveButton();
  }
};

function areaSkeleton() {
  const wrap = document.createDocumentFragment();
  for (let i = 0; i < 2; i++) {
    wrap.append(h('div', { class:'area' },
      h('div', { class:'info' }, h('div', { class:'skel', style:'width:45%' }),
        h('div', { class:'skel', style:'width:70%;margin-top:6px' }))));
  }
  return wrap;
}

/** The topbar campaign scope - "All areas" plus one option per defined area. */
function renderAreaSelect(areas) {
  const sel = el('areaSel');
  const frag = document.createDocumentFragment();
  frag.append(h('option', { text:'All areas', attrs:{ value:'' } }));
  for (const [k, a] of Object.entries(areas || {})) {
    frag.append(h('option', { text: a.label || k, attrs:{ value:k } }));
  }
  sel.replaceChildren(frag);
  sel.value = state.area;
}

export async function loadAreas() {
  const wrap = el('areas');
  wrap.replaceChildren(areaSkeleton());
  let data;
  try {
    const res = await fetch('/api/areas');
    if (!res.ok) throw new Error('server returned ' + res.status);
    data = await res.json();
  } catch (err) {
    wrap.replaceChildren(h('p', { class:'hint', text:'Could not load areas: ' + (err.message || 'network error') }));
    return;
  }
  const areas = (data && data.areas) || {};
  state.areas = areas;
  renderAreaSelect(areas);
  const keys = Object.keys(areas);
  existing.clearLayers();
  if (!keys.length) {
    wrap.replaceChildren(h('div', { class:'state', style:'padding:22px 8px' },
      h('h3', { text:'No areas yet' }),
      h('p', { text:'Draw a rectangle above, name it, and save it. Campaigns run per area.' })));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const k of keys) {
    const a = areas[k];
    const bb = Array.isArray(a.bbox) ? a.bbox : [];
    if (bb.length === 4) {
      // bbox is [S, W, N, E]; Leaflet wants [[S,W],[N,E]].
      L.rectangle([[bb[0], bb[1]], [bb[2], bb[3]]], {
        color:'#4fd1a5', weight:1, fillOpacity:.06, interactive:false,
      }).addTo(existing);
    }
    frag.append(h('div', { class:'area' },
      h('div', { class:'info' },
        h('b', { text: a.label || k }),
        h('span', { text: k + '  ·  ' + bb.join(', '), attrs:{ title:'[S, W, N, E]' } })),
      bb.length === 4 ? h('button', {
        class:'btn btn-sm', text:'Show',
        attrs:{ title:'Zoom the map to this area' },
        on:{ click: () => map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding:[20, 20] }) },
      }) : null,
      h('button', {
        class:'btn btn-accent btn-sm', text:'Run campaign',
        on:{ click: () => run(k, a.label || k) },
      })));
  }
  wrap.replaceChildren(frag);
}

/* ---- campaign stream ---------------------------------------------------- */

let stream = null, runStart = 0, runTimer = null, logLines = 0;
const MAX_LOG_LINES = 2000;

export function logLine(text, cls) {
  const box = el('log');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.append(h('div', { class: cls || '', text }));
  logLines++;
  if (logLines > MAX_LOG_LINES && box.firstChild) { box.removeChild(box.firstChild); logLines--; }
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

/** Classify a raw stdout line so a 40-line run is skimmable. */
function classify(line) {
  const t = line.trim();
  if (/FAILED|Error:|error:|ENOENT|Unknown /.test(t)) return 'l-err';
  if (t.startsWith('>')) return 'l-stage';
  if (t.startsWith('!')) return 'l-warn';
  if (t.startsWith('-')) return 'l-skip';
  return '';
}

function setRunning(on, label) {
  const chip = el('runchip');
  el('stoprun').hidden = !on;
  if (on) {
    chip.hidden = false;
    chip.replaceChildren(h('span', { class:'dot pulse', attrs:{ 'aria-hidden':'true' } }),
      h('span', { text:'Running · ' + label }));
    chip.setAttribute('title', 'Campaign running on ' + label + ' — click to view output');
  } else {
    chip.hidden = true;
  }
}

function tickElapsed(label, note) {
  const secs = Math.round((Date.now() - runStart) / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  el('runstate').textContent = (note || 'Running') + ' · ' + label + ' · ' + mm + ':' + ss;
}

function run(area, label) {
  if (stream) stream.close();
  const dry = el('dry').checked;
  el('log').replaceChildren(); logLines = 0;
  openOps();
  logLine('$ campaign --area ' + area + (dry ? ' --dry-run' : ''), 'l-stage');
  if (dry) logLine('dry run: nothing will be written to the store.', 'l-warn');

  runStart = Date.now();
  tickElapsed(label);
  clearInterval(runTimer);
  runTimer = setInterval(() => tickElapsed(label), 1000);
  setRunning(true, label);

  const q = new URLSearchParams({ area, dryRun: dry ? '1' : '0' });
  stream = new EventSource('/api/campaign?' + q);

  stream.addEventListener('log', (e) => {
    let line;
    try { line = JSON.parse(e.data); } catch { line = String(e.data); }
    logLine(line, classify(line));
  });

  stream.addEventListener('done', (e) => {
    let code = 0;
    try { code = JSON.parse(e.data); } catch { code = e.data; }
    const ok = String(code) === '0';
    logLine('— finished, exit ' + code + ' —', ok ? 'l-done' : 'l-err');
    finishRun(label, ok ? 'Finished' : 'Failed (exit ' + code + ')');
    toast(ok ? 'Campaign finished: ' + label : 'Campaign failed (exit ' + code + ')', ok ? 'ok' : 'err');
    loadLeads();
  });

  stream.onerror = () => {
    // EventSource retries by default; a dead server would loop forever.
    if (!stream) return;
    logLine('stream lost — connection to the console server dropped.', 'l-err');
    finishRun(label, 'Disconnected');
    toast('Campaign stream disconnected', 'err');
  };
}

function finishRun(label, note) {
  if (stream) { stream.close(); stream = null; }
  clearInterval(runTimer); runTimer = null;
  tickElapsed(label, note);
  setRunning(false);
}

el('stoprun').onclick = () => {
  if (!stream) return;
  const label = el('runstate').textContent.split(' · ')[1] || '';
  logLine('stopped by operator.', 'l-warn');
  // Closing the EventSource drops the request; the server kills the child.
  finishRun(label, 'Stopped');
  toast('Campaign stopped', 'ok');
};

el('clearlog').onclick = () => {
  el('log').replaceChildren(h('div', { class:'l-idle', text:'idle.' }));
  logLines = 1;
};

/* ---- ops sheet ---------------------------------------------------------- */

let lastFocus = null;

export function openOps() {
  const sheet = el('ops'), back = el('backdrop');
  if (!sheet.hidden) return;
  lastFocus = document.activeElement;
  sheet.hidden = false; back.hidden = false;
  // Force a reflow so the transition starts from the off-screen state. A
  // requestAnimationFrame here would be throttled in a background tab and the
  // panel would never slide in at all.
  void sheet.offsetWidth;
  sheet.classList.add('on'); back.classList.add('on');
  sheet.setAttribute('aria-hidden', 'false');
  // Leaflet cannot measure a hidden container.
  setTimeout(() => { map.invalidateSize(); el('closeops').focus(); }, 60);
}

export function closeOps() {
  const sheet = el('ops'), back = el('backdrop');
  if (sheet.hidden) return;
  sheet.classList.remove('on'); back.classList.remove('on');
  sheet.setAttribute('aria-hidden', 'true');
  setTimeout(() => { sheet.hidden = true; back.hidden = true; }, 160);
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

el('openops').onclick = openOps;
el('closeops').onclick = closeOps;
el('backdrop').onclick = closeOps;
el('runchip').onclick = openOps;

// Keep Tab inside the sheet while it is modal.
el('ops').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const f = el('ops').querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])');
  const list = Array.from(f).filter((n) => n.offsetParent !== null && !n.disabled);
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
