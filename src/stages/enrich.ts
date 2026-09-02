/**
 * Stage: find contacts on the business's own channels.
 *
 * Verification reads the Google Maps panel, and that panel yields a phone and
 * essentially nothing else - email, Instagram, Facebook and TikTok all come
 * back empty. Those are the channels outreach actually uses, so somebody has
 * to go and look at the business's own pages. This is that stage.
 *
 * Three rules shape the whole file:
 *
 * 1. Facebook and Instagram wall logged-out visitors, aggressively and
 *    inconsistently. A walled page is REPORTED as walled and its fields are
 *    left empty - never half-filled from whatever markup leaked past the
 *    overlay, because a plausible-looking wrong handle is worse than a blank.
 *
 * 2. A search-results page lists a dozen businesses' handles side by side, so
 *    anything harvested there has to look like THIS business before it is
 *    written. The lead's own page needs no such check; a shared page does.
 *
 * 3. An existing value always wins. Enrichment runs after verification and
 *    after any hand-editing, and `contactPatch` is what enforces that.
 */
import type { Browser, Page } from 'playwright';
import { launch, jitter, nameSimilarity } from '../fetcher.ts';
import { openStore } from '../store.ts';
import { classifyWebsite } from '../website.ts';
import { registerStage, type StageResult } from '../campaign-stages.ts';
import {
  extractHandles, contactPatch, ENRICHABLE,
  type EnrichableChannel, type Handles,
} from '../social.ts';
import type { Lead } from '../lead.ts';

/**
 * Identical to the Maps fetcher's context: same UA, same locale, same
 * timezone, same image blocking. Duplicated only because fetcher.ts keeps its
 * UA constant module-private - if it is ever exported, import it instead of
 * maintaining two copies that can drift apart.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const BLOCK_IMAGES = '**/*.{png,jpg,jpeg,webp,gif,svg,woff,woff2,mp4}';

/**
 * Bing, and not for want of trying the alternatives. Google's results sit
 * behind the same consent interstitial the Maps fetcher refuses to click
 * through; DuckDuckGo (both the html and lite endpoints), Mojeek and
 * Startpage all serve a bot challenge to a headless browser, and solving a
 * CAPTCHA is not something this pipeline does. Bing answers a plain
 * logged-out request, which is the whole requirement.
 */
const SEARCH_ENDPOINT = 'https://www.bing.com/search?q=';

/**
 * Social platforms punish bursts far harder than Maps does, and this stage
 * hits them directly rather than through a search index. Eight seconds is the
 * floor; `jitter` adds up to 60% on top of whatever it is given.
 */
export const MIN_PACE_MS = 8_000;

/** How much a handle must resemble the business name to survive a shared page. */
export const IDENTITY_MIN = 0.6;

// ---- planning (pure) --------------------------------------------------------

export interface EnrichSource {
  /** `own` pages are trusted; `search` results are shared ground. */
  kind: 'own' | 'search';
  url: string;
  /** Goes into handoff reasons, so it has to read like something to open. */
  label: string;
}

/** A lead this stage has anything to do for. */
export function needsEnrichment(lead: Lead, area: string): boolean {
  return lead.area === area
    && lead.status === 'verified'
    && (lead.email ?? '').trim() === '';
}

const withProtocol = (url: string): string =>
  /^https?:\/\//i.test(url) ? url : `https://${url}`;

/**
 * Where to look, best source first.
 *
 * The lead's own website_url comes first when it IS the business's social
 * page - that page is the business speaking about itself, and anything on it
 * can be believed. The search is the fallback for the (common) case where
 * verification found no web presence at all.
 */
export function planSources(lead: Lead, areaLabel: string): EnrichSource[] {
  const out: EnrichSource[] = [];
  const own = (lead.website_url ?? '').trim();
  const kind = classifyWebsite(own).kind;
  if (own && (kind === 'facebook' || kind === 'instagram')) {
    out.push({ kind: 'own', url: withProtocol(own), label: `their ${kind} page ${own}` });
  }
  const query = `"${lead.name}" ${areaLabel} instagram`;
  out.push({
    kind: 'search',
    url: SEARCH_ENDPOINT + encodeURIComponent(query),
    label: `web search ${query}`,
  });
  return out;
}

// ---- trusting what a shared page says (pure) --------------------------------

/**
 * The names a contact claims, as words a name comparison can use.
 *
 * An address gives two chances on purpose: `kurocafe@gmail.com` identifies
 * the business in its local part, `hello@kurocafe.ph` in its domain. Checking
 * only one of them would throw away whichever half of the Philippine SME
 * population uses the other.
 */
function identityCandidates(channel: EnrichableChannel, value: string): string[] {
  if (channel !== 'email') return [value.replace(/^@/, '')];
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const labels = value.slice(at + 1).split('.');
  // "kurocafe.com.ph" -> kurocafe, not "com". A two-or-three letter
  // second-level label is a public suffix (co.uk, com.ph), never a business.
  const secondLevel = labels[labels.length - 2] ?? '';
  const sld = secondLevel.length <= 3 ? (labels[labels.length - 3] ?? secondLevel) : secondLevel;
  return [local, sld];
}

/** Could this contact belong to this business? Only asked of shared pages. */
export function looksLikeThisBusiness(
  name: string, channel: EnrichableChannel, value: string,
): boolean {
  return identityCandidates(channel, value)
    .filter((c) => c !== '')
    // Separators are word breaks: "kuro.cafe" and "kuro_cafe" are "kuro cafe".
    .some((c) => nameSimilarity(name, c.replace(/[._\-+]+/g, ' ')) >= IDENTITY_MIN);
}

/** Everything a shared page said that survives the identity check. */
export function trustedHandles(name: string, found: Handles): Handles {
  const out: Handles = {};
  for (const channel of ENRICHABLE) {
    const value = (found[channel] ?? '').trim();
    if (value && looksLikeThisBusiness(name, channel, value)) out[channel] = value;
  }
  return out;
}

/** Accumulate across sources. The earlier (better) source wins every field. */
export function mergeFound(base: Handles, extra: Handles): Handles {
  const out: Handles = { ...base };
  for (const channel of ENRICHABLE) {
    if ((out[channel] ?? '') === '' && (extra[channel] ?? '') !== '') {
      out[channel] = extra[channel];
    }
  }
  return out;
}

/** Channels still blank after everything found so far. */
export function missingChannels(lead: Lead, found: Handles): EnrichableChannel[] {
  return ENRICHABLE.filter(
    (c) => (lead[c] ?? '').trim() === '' && (found[c] ?? '').trim() === '',
  );
}

// ---- wall detection (pure) --------------------------------------------------

export type Wall = 'consent' | 'login' | 'blocked';

const WALL_URL: readonly (readonly [RegExp, Wall])[] = [
  [/consent\.google\.|\/sorry\/index|\/privacy\/consent/i, 'consent'],
  [/\/accounts\/login|\/login\.php|facebook\.com\/login|\/checkpoint\//i, 'login'],
  [/\/challenge\//i, 'blocked'],
];

/**
 * Phrases chosen to be long enough that ordinary page copy cannot trip them.
 * A false "walled" reading costs one lead a handoff line; a false "fine"
 * reading feeds overlay markup to the extractor, which is the failure this
 * whole stage is written to avoid.
 */
const WALL_TEXT: readonly (readonly [RegExp, Wall])[] = [
  [/before you continue to google/i, 'consent'],
  [/you must log in to continue/i, 'login'],
  [/log in to continue/i, 'login'],
  [/(?:log|sign) in to see photos and videos/i, 'login'],
  [/sign up to see photos and videos/i, 'login'],
  [/see more of .{1,60} on facebook/i, 'login'],
  [/(?:you(?:'|’)?re |account has been )?temporarily blocked/i, 'blocked'],
  [/we (?:limit|restrict) how often/i, 'blocked'],
  [/unusual activity from your/i, 'blocked'],
  [/this (?:content|page) isn(?:'|’)t available/i, 'blocked'],
  [/(?:sorry, )?something went wrong.{0,40}we(?:'|’)re working on it/i, 'blocked'],
  // Search-engine bot challenges. Observed live on the DuckDuckGo html and
  // lite endpoints, Mojeek and Startpage. Solving one is out of the question,
  // so the only honest reading is "this page refused us" - otherwise the
  // challenge text gets scraped and reported as "nothing found", which is a
  // lie about a page nobody looked at.
  [/(?:bots use duckduckgo too|made by a human|complete the following challenge)/i, 'blocked'],
  [/(?:appears to be )?sending automated queries/i, 'blocked'],
  [/unusual traffic from your computer network/i, 'blocked'],
  [/verifying your request/i, 'blocked'],
];

/** Is this page refusing to show us the business, rather than showing it? */
export function detectWall(url: string, text: string): Wall | null {
  for (const [re, wall] of WALL_URL) if (re.test(url)) return wall;
  // Only the top of the page: a footer link reading "Log in to continue" on an
  // otherwise readable page is not a wall.
  const head = (text ?? '').slice(0, 2_000);
  for (const [re, wall] of WALL_TEXT) if (re.test(head)) return wall;
  return null;
}

// ---- reporting (pure) -------------------------------------------------------

export interface EnrichReport {
  attempted: number;
  /** Leads that gained at least one contact. */
  enriched: number;
  /** Contacts newly written, per channel. */
  gained: Record<EnrichableChannel, number>;
  fetches: number;
  /** True when the fetch budget stopped the run early. */
  budgetExhausted: boolean;
  walled: number;
  handoff: { lead: Lead; reason: string }[];
}

export function emptyGains(): Record<EnrichableChannel, number> {
  return { email: 0, instagram: 0, facebook: 0, tiktok: 0 };
}

/** The line the campaign brief prints. Coverage gained, per channel. */
export function coverageSummary(r: EnrichReport): string {
  const gained = ENRICHABLE.map((c) => `${c} +${r.gained[c]}`).join('  ');
  return (
    `${r.enriched}/${r.attempted} leads gained a contact  ${gained}` +
    `  (${r.fetches} page loads)` +
    (r.walled ? `  ${r.walled} walled` : '') +
    (r.budgetExhausted ? '  - stopped on the fetch cap' : '')
  );
}

// ---- the browser part -------------------------------------------------------

export interface EnrichOptions {
  area: string;
  areaLabel: string;
  /** Fetch budget for the whole run, shared across leads. */
  maxFetches: number;
  dryRun?: boolean;
  paceMs?: number;
  headed?: boolean;
  log?: (msg: string) => void;
}

type Visit =
  | { ok: true; handles: Handles }
  | { ok: false; wall: Wall }
  | { ok: false; wall: null; detail: string };

/**
 * Load one page in a throwaway context and read what it says about itself.
 *
 * A fresh context per visit is deliberate: no cookie ever carries from one
 * business's Facebook page to the next, so the visits stay unlinkable and we
 * are always the logged-out visitor we claim to be.
 */
async function visit(browser: Browser, source: EnrichSource): Promise<Visit> {
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-PH', timezoneId: 'Asia/Manila',
    viewport: { width: 1280, height: 900 },
  });
  const page: Page = await ctx.newPage();
  await page.route(BLOCK_IMAGES, (r) => r.abort());
  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Social pages hydrate their content - and their login overlays - after
    // first paint, so reading immediately would miss both.
    await page.waitForTimeout(2_500);

    let text = '';
    try {
      text = await page.locator('body').innerText({ timeout: 5_000 });
    } catch {
      // A body that never settles is not a reason to lose the HTML.
    }
    const html = await page.content();

    const wall = detectWall(page.url(), text);
    if (wall) return { ok: false, wall };
    return { ok: true, handles: extractHandles(text, html) };
  } catch (err) {
    return { ok: false, wall: null, detail: (err as Error).message };
  } finally {
    await ctx.close();
  }
}

export async function enrichLeads(opts: EnrichOptions): Promise<EnrichReport> {
  const log = opts.log ?? (() => {});
  const store = openStore();
  const pace = Math.max(opts.paceMs ?? MIN_PACE_MS, MIN_PACE_MS);

  const pool = (await store.all())
    .filter((l) => needsEnrichment(l, opts.area))
    .sort((a, b) => Number(b.osm_score) - Number(a.osm_score));

  const report: EnrichReport = {
    attempted: pool.length, enriched: 0, gained: emptyGains(),
    fetches: 0, budgetExhausted: false, walled: 0, handoff: [],
  };
  if (pool.length === 0) return report;
  if (opts.maxFetches <= 0) {
    report.budgetExhausted = true;
    report.attempted = 0;
    return report;
  }

  const browser = await launch(!opts.headed);
  try {
    for (const [i, lead] of pool.entries()) {
      if (report.fetches >= opts.maxFetches) {
        report.budgetExhausted = true;
        // Everything after this point is untouched, not failed - it will be
        // picked up by the next run, which is the whole point of the caps.
        report.attempted = i;
        break;
      }

      let found: Handles = {};
      const walls: string[] = [];

      for (const source of planSources(lead, opts.areaLabel)) {
        if (report.fetches >= opts.maxFetches) { report.budgetExhausted = true; break; }
        if (report.fetches > 0) await jitter(pace);
        report.fetches++;

        const res = await visit(browser, source);
        if (!res.ok) {
          if (res.wall) walls.push(`${res.wall} wall on ${source.label}`);
          else log(`  ${lead.name.slice(0, 28)}: ${source.kind} source failed - ${res.detail}`);
          continue;
        }
        // Own pages speak for themselves; a search page speaks for everyone,
        // so only the handles that look like this business survive it.
        const usable = source.kind === 'own'
          ? res.handles
          : trustedHandles(lead.name, res.handles);
        found = mergeFound(found, usable);

        if (missingChannels(lead, found).length === 0) break;
      }

      const patch = contactPatch(lead, found);
      const filled = ENRICHABLE.filter((c) => (patch[c] ?? '') !== '');
      if (filled.length > 0) {
        if (!opts.dryRun) await store.update(lead.lead_id, patch);
        report.enriched++;
        for (const c of filled) report.gained[c]++;
      }

      // A wall only becomes a handoff when it cost us the thing we came for.
      // Email is the reason this stage runs; if a wall hid it, a person has to
      // open that page themselves. Guessing is not on the menu.
      const stillNoEmail = (lead.email ?? '').trim() === '' && (found.email ?? '').trim() === '';
      if (walls.length > 0) {
        report.walled++;
        if (stillNoEmail) {
          report.handoff.push({
            lead,
            reason: `contacts are behind a login: ${walls.join('; ')}`
              + ` - open it yourself and paste the email into the sheet`,
          });
        }
      }

      log(
        `${i + 1}/${pool.length} ${lead.name.slice(0, 32).padEnd(33)} ` +
        (filled.length ? `+ ${filled.join(', ')}` : walls.length ? 'walled' : 'nothing found'),
      );
    }
  } finally {
    await browser.close();
  }
  return report;
}

registerStage({
  name: 'enrich',
  description: "find contacts on the business's own channels",
  consumes: ['verified'],
  async run(ctx): Promise<StageResult> {
    const r = await enrichLeads({
      area: ctx.area,
      areaLabel: ctx.areaLabel,
      maxFetches: ctx.caps.maxFetches,
      dryRun: ctx.dryRun,
      log: ctx.log,
    });
    if (r.attempted === 0) return { processed: 0, summary: 'no verified leads are missing an email' };
    return {
      processed: r.enriched,
      summary: coverageSummary(r),
      handoff: r.handoff,
    };
  },
});
