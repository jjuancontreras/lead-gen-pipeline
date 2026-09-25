'use strict';
/**
 * One modal side sheet for the Work Queue: a pitch draft, a recording, a
 * BUILD-PROMPT path. Focus moves into it, Tab stays inside it, Escape or the
 * backdrop closes it, and focus returns to whatever opened it.
 */
import { el } from './dom.js';

let opener = null;

function focusables() {
  return Array.from(el('dlg').querySelectorAll(
    'button:not([disabled]), [href], video, input, select, textarea, [tabindex]:not([tabindex="-1"])'));
}

export function openDialog(title, body, from) {
  opener = from || document.activeElement;
  el('dlg-title').textContent = title;
  el('dlg-body').replaceChildren(body);
  el('backdrop').hidden = false;
  el('dlg').hidden = false;
  requestAnimationFrame(() => { el('backdrop').classList.add('on'); el('dlg').classList.add('on'); });
  el('dlg-close').focus();
}

export function closeDialog() {
  if (el('dlg').hidden) return;
  el('dlg').classList.remove('on');
  el('backdrop').classList.remove('on');
  el('dlg').hidden = true;
  el('backdrop').hidden = true;
  el('dlg-body').replaceChildren();
  if (opener && document.contains(opener)) opener.focus();
  opener = null;
}

export function wireDialog() {
  el('dlg-close').addEventListener('click', closeDialog);
  el('backdrop').addEventListener('click', closeDialog);
  el('dlg').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
}
