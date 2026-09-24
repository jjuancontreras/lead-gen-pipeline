/**
 * The demo site: one static, self-contained HTML page per business.
 *
 * It says only what is known. Every line on the page comes from the lead's
 * own record - name, category, area, cuisine, phone, email, social pages,
 * map position - and the footer says plainly that it is a demo built from
 * public listings. Nothing is invented to fill space: a business with no
 * phone on record gets no phone button.
 *
 * Self-contained on purpose: no web fonts, no CDN, no map embed. It renders
 * offline, in the recorder, and in a test, exactly as it would online.
 */
import { formatPhoneDisplay } from '../scaffold.ts';
import { socialUrl } from '../draft-file.ts';
import type { FoundLead } from './schemas.ts';

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** Only these schemes ever reach an href. */
function safeHref(url: string): string | null {
  const u = url.trim();
  return /^(https?:\/\/|tel:|mailto:)/i.test(u) ? esc(u) : null;
}

/** A stable hue per business, so three demos do not look like one template. */
export function hueFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

/** "coffee_shop;filipino" -> "Coffee shop · Filipino". */
export function formatCuisine(raw: string): string {
  return raw.split(/[;,]/)
    .map((c) => c.trim().replace(/_/g, ' '))
    .filter(Boolean)
    .map((c) => c[0]!.toUpperCase() + c.slice(1))
    .join(' · ');
}

const telHref = (phone: string): string => `tel:${phone.replace(/[^\d+]/g, '')}`;

function mapsHref(f: FoundLead): string {
  if (f.mapsUrl) return f.mapsUrl;
  const q = f.lat && f.lng ? `${f.lat},${f.lng}` : `${f.name} ${f.areaLabel}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

interface Action { label: string; href: string; primary?: boolean }

/** A phone number must never wrap mid-number: spaces become non-breaking. */
const noWrap = (text: string): string => esc(text).replace(/ /g, '&nbsp;');

function actions(f: FoundLead): Action[] {
  const out: Action[] = [];
  if (f.phone) out.push({ label: `Call ${formatPhoneDisplay(f.phone)}`, href: telHref(f.phone), primary: true });
  if (f.email) out.push({ label: 'Send an email', href: `mailto:${f.email}` });
  if (f.instagram) out.push({ label: 'Instagram', href: socialUrl('instagram', f.instagram) });
  if (f.facebook) out.push({ label: 'Facebook', href: socialUrl('facebook', f.facebook) });
  if (f.tiktok) out.push({ label: 'TikTok', href: socialUrl('tiktok', f.tiktok) });
  out.push({ label: 'Get directions', href: mapsHref(f), primary: out.length === 0 });
  return out;
}

function buttons(list: readonly Action[]): string {
  return list.flatMap((a) => {
    const href = safeHref(a.href);
    if (!href) return [];
    const external = /^https?:/i.test(a.href) ? ' rel="noopener" target="_blank"' : '';
    const label = a.href.startsWith('tel:') ? noWrap(a.label) : esc(a.label);
    return [`<a class="btn${a.primary ? ' btn-primary' : ''}" href="${href}"${external}>${label}</a>`];
  }).join('\n          ');
}

function contactRows(f: FoundLead): string {
  const rows: [string, string, string | null][] = [
    ['Phone', f.phone ? formatPhoneDisplay(f.phone) : '', f.phone ? telHref(f.phone) : null],
    ['Email', f.email, f.email ? `mailto:${f.email}` : null],
    ['Instagram', f.instagram, f.instagram ? socialUrl('instagram', f.instagram) : null],
    ['Facebook', f.facebook, f.facebook ? socialUrl('facebook', f.facebook) : null],
    ['TikTok', f.tiktok, f.tiktok ? socialUrl('tiktok', f.tiktok) : null],
  ];
  return rows.filter(([, v]) => v).map(([k, v, href]) => {
    const safe = href ? safeHref(href) : null;
    const text = href?.startsWith('tel:') ? noWrap(v) : esc(v);
    const value = safe ? `<a href="${safe}">${text}</a>` : text;
    return `<div class="row"><dt>${k}</dt><dd>${value}</dd></div>`;
  }).join('\n            ');
}

function styles(hue: number): string {
  return `
    :root {
      --accent: hsl(${hue} 55% 30%);
      --accent-soft: hsl(${hue} 45% 94%);
      --ink: #1c1b1a;
      --muted: #55524e;
      --paper: #fbfaf8;
      --line: #e4e0da;
      --radius: 14px;
      --gutter: clamp(1rem, 4vw, 3rem);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0; background: var(--paper); color: var(--ink);
      font: 400 1.0625rem/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    a { color: var(--accent); }
    a:focus-visible, .btn:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
    .wrap { max-width: 68rem; margin: 0 auto; padding: 0 var(--gutter); }
    header.top { border-bottom: 1px solid var(--line); background: #fff; }
    header.top .wrap { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 4rem; }
    .logo { font-weight: 700; letter-spacing: -0.01em; color: var(--ink); text-decoration: none; }
    nav ul { display: flex; gap: 1.25rem; list-style: none; margin: 0; padding: 0; }
    nav a { color: var(--muted); text-decoration: none; font-size: 0.95rem; }
    nav a:hover { color: var(--accent); }
    section { padding: clamp(3rem, 10vh, 6rem) 0; border-bottom: 1px solid var(--line); }
    .hero { min-height: 82vh; display: flex; align-items: center; background: var(--accent-soft); }
    .kicker { text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.8rem; color: var(--accent); font-weight: 700; margin: 0 0 0.75rem; }
    h1 { font-size: clamp(2.25rem, 7vw, 4.5rem); line-height: 1.05; letter-spacing: -0.02em; margin: 0 0 1rem; }
    h2 { font-size: clamp(1.6rem, 4vw, 2.4rem); line-height: 1.15; margin: 0 0 1rem; }
    .lede { font-size: clamp(1.1rem, 2.4vw, 1.35rem); color: var(--muted); max-width: 40rem; margin: 0 0 2rem; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }
    .btn {
      display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0.6rem 1.2rem;
      border-radius: 999px; border: 2px solid var(--accent); color: var(--accent);
      background: #fff; font-weight: 600; text-decoration: none;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .grid { display: grid; gap: 2rem; grid-template-columns: 1fr; }
    .card { background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: 1.5rem; }
    dl { margin: 0; }
    .row { display: grid; grid-template-columns: 7rem 1fr; gap: 1rem; padding: 0.75rem 0; border-bottom: 1px solid var(--line); }
    .row:last-child { border-bottom: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    footer { padding: 2.5rem 0 3rem; color: var(--muted); font-size: 0.9rem; }
    @media (min-width: 48rem) {
      .grid { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 30rem) {
      nav { display: none; }
      .row { grid-template-columns: 1fr; gap: 0.25rem; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
    }`;
}

export interface SiteOptions {
  /** Who prepared the demo - named in the footer disclosure. */
  senderName: string;
  year: number;
}

export function renderSiteHtml(f: FoundLead, opts: SiteOptions): string {
  const cuisine = formatCuisine(f.cuisine);
  const what = `${f.category} in ${f.areaLabel}`;
  const about = cuisine
    ? `${esc(f.name)} is a ${esc(f.category.toLowerCase())} in ${esc(f.areaLabel)}, serving ${esc(cuisine.toLowerCase())}.`
    : `${esc(f.name)} is a ${esc(f.category.toLowerCase())} in ${esc(f.areaLabel)}.`;
  const contacts = contactRows(f);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(f.name)} - ${esc(what)}</title>
    <meta name="description" content="${esc(f.name)}: ${esc(what)}. Contact details and directions.">
    <style>${styles(hueFor(f.name))}
    </style>
  </head>
  <body>
    <header class="top">
      <div class="wrap">
        <a class="logo" href="#top">${esc(f.name)}</a>
        <nav aria-label="Sections">
          <ul>
            <li><a href="#about">About</a></li>
            <li><a href="#visit">Visit</a></li>
            <li><a href="#contact">Contact</a></li>
          </ul>
        </nav>
      </div>
    </header>
    <main id="top">
      <section class="hero" data-section="hero">
        <div class="wrap">
          <p class="kicker">${esc(what)}</p>
          <h1>${esc(f.name)}</h1>
          <p class="lede">${about}</p>
          <div class="actions">
          ${buttons(actions(f))}
          </div>
        </div>
      </section>
      <section id="about" data-section="about">
        <div class="wrap grid">
          <div>
            <h2>About ${esc(f.name)}</h2>
            <p>${about}</p>
          </div>
          <div class="card">
            <dl>
            <div class="row"><dt>What</dt><dd>${esc(f.category)}</dd></div>
            ${cuisine ? `<div class="row"><dt>Serving</dt><dd>${esc(cuisine)}</dd></div>` : ''}
            <div class="row"><dt>Where</dt><dd>${esc(f.areaLabel)}</dd></div>
            </dl>
          </div>
        </div>
      </section>
      <section id="visit" data-section="visit">
        <div class="wrap grid">
          <div>
            <h2>Visit us</h2>
            <p>Find ${esc(f.name)} in ${esc(f.areaLabel)}.</p>
          </div>
          <div class="actions">
          ${buttons([{ label: 'Open in Google Maps', href: mapsHref(f), primary: true }])}
          </div>
        </div>
      </section>
      <section id="contact" data-section="contact">
        <div class="wrap grid">
          <div>
            <h2>Get in touch</h2>
            <p>${contacts ? `Reach ${esc(f.name)} directly:` : `Drop by ${esc(f.name)} in ${esc(f.areaLabel)}.`}</p>
          </div>
          ${contacts ? `<div class="card"><dl>
            ${contacts}
          </dl></div>` : ''}
        </div>
      </section>
    </main>
    <footer>
      <div class="wrap">
        <p>&copy; ${opts.year} ${esc(f.name)}.</p>
        <p>This is a demo website prepared by ${esc(opts.senderName)}. The details come from public listings and have not yet been confirmed by ${esc(f.name)}.</p>
      </div>
    </footer>
  </body>
</html>
`;
}
