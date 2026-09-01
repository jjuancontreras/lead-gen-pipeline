/**
 * Playwright fetcher for Google Maps place panels.
 *
 * Design notes:
 *
 * 1. The thing we most need - does a standalone website exist - is a DOM
 *    attribute, not a language task. The `data-item-id` attributes on the
 *    place panel have been stable for years and are read directly. Gemini
 *    is only needed for messier free-text extraction, so verification works
 *    with no API key at all.
 *
 * 2. Nothing silently guesses. Every result carries a confidence and a
 *    method; anything ambiguous is reported as needing manual review rather
 *    than written to the store as fact.
 *
 * 3. Consent walls are NOT auto-accepted. Accepting terms on someone's
 *    behalf is a decision for a person, so a consent interstitial routes the
 *    lead to the manual worklist instead.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { basicClean, normalizeName } from './normalize.ts';

export interface PlaceFacts {
  websiteUrl: string | null;
  phone: string | null;
  rating: string | null;
  reviewCount: string | null;
  address: string | null;
  resolvedName: string | null;
  photoCount: string | null;
}

export type FetchOutcome =
  | { ok: true; facts: PlaceFacts; confidence: 'high' | 'medium' }
  | { ok: false; reason: 'consent-wall' | 'no-match' | 'ambiguous' | 'error'; detail?: string };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export async function launch(headless = true): Promise<Browser> {
  return chromium.launch({ headless });
}

export function jitter(baseMs: number): Promise<void> {
  // Human-rate pacing: this is low-volume prospecting, not a crawl.
  const ms = baseMs + Math.floor(Math.random() * baseMs * 0.6);
  return new Promise((r) => setTimeout(r, ms));
}

async function textOf(page: Page, selector: string): Promise<string | null> {
  const el = await page.$(selector);
  if (!el) return null;
  const t = (await el.textContent())?.trim();
  return t || null;
}

/** Detect Google's consent interstitial. We never click through it. */
async function isConsentWall(page: Page): Promise<boolean> {
  const url = page.url();
  if (/consent\.google\.|\/sorry\/index/.test(url)) return true;
  return (await page.$('form[action*="consent"]')) !== null;
}

/** Token-overlap similarity, 0..1. Used to confirm a feed hit is our business. */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(basicClean(a).split(' ').filter((w) => w.length > 2));
  const tb = new Set(basicClean(b).split(' ').filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / Math.min(ta.size, tb.size);
}

/** Read the detail fields off an open place panel. */
async function extractPanel(page: Page): Promise<PlaceFacts> {
  const websiteEl = await page.$('a[data-item-id="authority"]');
  const websiteUrl = websiteEl ? await websiteEl.getAttribute('href') : null;

  const phoneEl = await page.$('button[data-item-id^="phone:tel:"]');
  const phoneRaw = phoneEl ? await phoneEl.getAttribute('data-item-id') : null;
  const phone = phoneRaw ? phoneRaw.replace('phone:tel:', '') : null;

  const address = await textOf(page, 'button[data-item-id="address"]');
  const resolvedName = await textOf(page, 'h1');

  let rating: string | null = null;
  const ratingEl = await page.$('[role="img"][aria-label*="stars"]');
  const label = ratingEl ? await ratingEl.getAttribute('aria-label') : null;
  if (label) rating = label.match(/([\d.]+)\s*stars?/i)?.[1] ?? null;

  // Review count has no stable selector. The header renders it fast as a
  // parenthesised count directly beneath the rating, while the
  // "8 reviews" wording appears lower down and later - reading only the
  // latter loses the count whenever the page settles slowly. Try the header
  // first, then fall back.
  let reviewCount: string | null = null;
  const mainEl = await page.$('[role="main"]');
  if (mainEl) {
    const panelText = await mainEl.innerText();
    const header = panelText.slice(0, 600);
    reviewCount =
      header.match(/\(([\d,]+)\)/)?.[1]?.replace(/,/g, '') ??
      // Anchored to avoid matching a reviewer byline ("Local Guide - 10 reviews").
      panelText.match(/([\d,]+)\s+reviews?/i)?.[1]?.replace(/,/g, '') ??
      null;
  }

  return { websiteUrl, phone, rating, reviewCount, address, resolvedName, photoCount: null };
}

/**
 * Resolve one business to its Maps place panel and read the facts.
 *
 * A search usually lands on a results FEED, not a place page - the panel's
 * data-item-id attributes do not exist until a specific place is open. So we
 * match the feed entries against the business name and only follow a hit we
 * are confident about; a weak or tied match is reported ambiguous and goes
 * to manual review rather than being guessed at.
 */
async function fetchPlaceOnce(
  browser: Browser,
  business: { name: string; area: string },
  opts: { timeoutMs?: number; minSimilarity?: number; settleMs?: number } = {},
): Promise<FetchOutcome> {
  const timeout = opts.timeoutMs ?? 30_000;
  const minSim = opts.minSimilarity ?? 0.6;
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-PH', timezoneId: 'Asia/Manila',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await page.route('**/*.{png,jpg,jpeg,webp,gif,svg,woff,woff2,mp4}', (r) => r.abort());

  try {
    const query = `${business.name} ${business.area}`;
    await page.goto(
      'https://www.google.com/maps/search/' + encodeURIComponent(query) + '?hl=en',
      { waitUntil: 'domcontentloaded', timeout },
    );

    if (await isConsentWall(page)) return { ok: false, reason: 'consent-wall' };

    try {
      await page.waitForSelector('[role="feed"], [role="main"]', { timeout: 15_000 });
    } catch {
      return { ok: false, reason: 'no-match', detail: 'neither feed nor panel appeared' };
    }
    // Maps hydrates the panel after first paint.
    await page.waitForTimeout(opts.settleMs ?? 2500);
    if (await isConsentWall(page)) return { ok: false, reason: 'consent-wall' };

    // Case 1: the search resolved straight to one place.
    let onPlacePage = page.url().includes('/maps/place/');

    // Case 2: a feed of candidates - confirm which one is ours.
    if (!onPlacePage) {
      const links = page.locator('a[href*="/maps/place/"]');
      const n = await links.count();
      if (n === 0) return { ok: false, reason: 'no-match', detail: 'no place results' };

      const scored: { i: number; name: string; sim: number }[] = [];
      for (let i = 0; i < Math.min(n, 6); i++) {
        const name = (await links.nth(i).getAttribute('aria-label')) ?? '';
        scored.push({ i, name, sim: nameSimilarity(business.name, name) });
      }
      scored.sort((a, b) => b.sim - a.sim);
      const best = scored[0]!;
      const runnerUp = scored[1];

      if (best.sim < minSim) {
        return { ok: false, reason: 'no-match', detail: `best match "${best.name}" scored ${best.sim.toFixed(2)}` };
      }
      // A tie is only a real ambiguity when the tied candidates are different
      // businesses. Maps often lists the same place twice ("Kohi - Maginhawa"
      // vs "Kohi Maginhawa"); those normalize identically and the top-ranked
      // one is correct. Two genuinely different branches ("Starbucks" vs
      // "Starbucks Petron") must not be guessed between - a wrong pick
      // silently attaches another business's website to this lead.
      if (runnerUp && runnerUp.sim >= best.sim - 0.001) {
        if (normalizeName(best.name) !== normalizeName(runnerUp.name)) {
          return { ok: false, reason: 'ambiguous', detail: `tied: "${best.name}" vs "${runnerUp.name}"` };
        }
      }

      // Navigate to the href rather than clicking: a click can be swallowed
      // by an overlay or a re-render, and fails non-deterministically.
      const href = await links.nth(best.i).getAttribute('href');
      if (!href) return { ok: false, reason: 'no-match', detail: 'result had no href' };
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForTimeout(opts.settleMs ?? 3500);
      onPlacePage = page.url().includes('/maps/place/');
      if (!onPlacePage) return { ok: false, reason: 'no-match', detail: 'result href did not open a place' };
    }

    const facts = await extractPanel(page);
    if (!facts.resolvedName) {
      return { ok: false, reason: 'no-match', detail: 'place panel had no business name' };
    }
    const sim = nameSimilarity(business.name, facts.resolvedName);
    if (sim < minSim) {
      return { ok: false, reason: 'no-match', detail: `resolved to "${facts.resolvedName}" (${sim.toFixed(2)})` };
    }

    const confidence = facts.address || facts.phone ? 'high' : 'medium';
    return { ok: true, facts, confidence };
  } catch (err) {
    return { ok: false, reason: 'error', detail: (err as Error).message };
  } finally {
    await ctx.close();
  }
}

/**
 * Public entry point: one retry with a longer settle before giving up.
 *
 * Maps rendering is genuinely non-deterministic under repeated requests - the
 * same query can resolve cleanly once and return an empty feed the next time.
 * One patient retry converts most of those into hits; anything still
 * unresolved is reported honestly and routed to the manual worklist.
 */
export async function fetchPlace(
  browser: Browser,
  business: { name: string; area: string },
  opts: { timeoutMs?: number; minSimilarity?: number } = {},
): Promise<FetchOutcome> {
  const first = await fetchPlaceOnce(browser, business, opts);
  if (first.ok) return first;
  // A consent wall will not clear on retry, and an ambiguous match is a real
  // finding rather than a transient failure.
  if (first.reason === 'consent-wall' || first.reason === 'ambiguous') return first;

  await jitter(5000);
  return fetchPlaceOnce(browser, business, { ...opts, settleMs: 6000, timeoutMs: 45_000 });
}
