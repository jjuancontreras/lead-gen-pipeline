'use strict';
import { el, h } from './dom.js';

export function toast(msg, kind) {
  const t = h('div', { class:'toast' + (kind ? ' ' + kind : ''), text: msg });
  el('toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}
