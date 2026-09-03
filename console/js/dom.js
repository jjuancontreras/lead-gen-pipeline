'use strict';
/* ===========================================================================
   HARD RULE FOR THIS FILE (and every module that imports h()): no value that
   came from the API is ever handed to innerHTML. Lead names, categories and
   notes are scraped off third-party pages, so every one of them goes in
   through textContent (or an attribute) and every container is emptied with
   replaceChildren(), never `= ''` on innerHTML. Static chrome is built with
   the same DOM helper so there is no innerHTML call anywhere to copy by
   accident.
=========================================================================== */

export const el = (id) => document.getElementById(id);

/** Build an element. `text` always goes through textContent. */
export function h(tag, opts, ...kids) {
  const n = document.createElement(tag);
  if (opts) {
    if (opts.class) n.className = opts.class;
    if (opts.text != null) n.textContent = String(opts.text);
    for (const [k, v] of Object.entries(opts.attrs || {})) {
      if (v != null) n.setAttribute(k, String(v));
    }
    if (opts.style) n.setAttribute('style', opts.style);
    if (opts.on) for (const [k, fn] of Object.entries(opts.on)) n.addEventListener(k, fn);
  }
  for (const k of kids) if (k) n.append(k);
  return n;
}
