'use strict';
/* ---- formatting + link-safety helpers ------------------------------------ */

export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Never trust a stored string to be a safe href. These fields are scraped, so:
 *   - an absolute value is only linked when it is http(s) AND on the social
 *     host we expect, which keeps the console from becoming a one-click
 *     launcher for whatever domain ended up in the record;
 *   - anything else is treated as a handle and encoded into a path segment,
 *     so `javascript:` and friends can never land in an href.
 * Returning null means the caller renders the raw value as plain text.
 */
export function socialUrl(host, value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    let u;
    try { u = new URL(v); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const hn = u.hostname.toLowerCase().replace(/^www\./, '');
    return (hn === host || hn.endsWith('.' + host)) ? u.href : null;
  }
  const handle = v.replace(/^@/, '').replace(/^\/+/, '').split(/[?#\s]/)[0];
  if (!handle) return null;
  return 'https://' + host + '/' + encodeURIComponent(handle);
}

/** A URL we generated ourselves (Vercel/etc) - still http(s)-only before it becomes a link. */
export function safeHttpUrl(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
  } catch { return null; }
}

export function bestContact(l) {
  if (l.email) return { ch:'email', v:l.email, href:'mailto:' + encodeURI(l.email) };
  if (l.phone) return { ch:'phone', v:l.phone, href:'tel:' + l.phone.replace(/[^\d+]/g, '') };
  if (l.instagram) return { ch:'ig', v:l.instagram, href:socialUrl('instagram.com', l.instagram) };
  if (l.facebook) return { ch:'fb', v:l.facebook, href:socialUrl('facebook.com', l.facebook) };
  if (l.tiktok) return { ch:'tiktok', v:l.tiktok, href:socialUrl('tiktok.com', l.tiktok) };
  return null;
}
