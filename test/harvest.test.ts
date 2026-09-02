import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeIgInput,
  instagramProfileUrl,
  parseInstagramGridHtml,
  limitImageUrls,
  gridFailureMessage,
  harvestFilename,
  guessExtFromUrl,
  computeResizeWidth,
  buildCurationPrompt,
  buildMenuOcrPrompt,
  selectRecommendedFilenames,
  fetchInstagramGrid,
  harvestAssets,
  CURATION_SCHEMA,
  MENU_OCR_SCHEMA,
  DEFAULT_LIMIT,
  MIN_LIMIT,
  MAX_LIMIT,
  type CurationSelectedItem,
} from '../src/harvest.ts';

/* -------------------------------------------------------------------------- */
/* Handle / URL parsing                                                       */
/* -------------------------------------------------------------------------- */

test('normalizeIgInput accepts a bare handle, an @handle, and a profile URL', () => {
  assert.equal(normalizeIgInput('kurocafe'), 'kurocafe');
  assert.equal(normalizeIgInput('@KuroCafe'), 'kurocafe');
  assert.equal(normalizeIgInput('https://www.instagram.com/kurocafe/'), 'kurocafe');
  assert.equal(normalizeIgInput('instagram.com/kurocafe?hl=en'), 'kurocafe');
});

test('normalizeIgInput rejects empty input and garbage that is not a handle shape', () => {
  assert.throws(() => normalizeIgInput(''));
  assert.throws(() => normalizeIgInput('   '));
  assert.throws(() => normalizeIgInput('this has spaces'));
});

test('instagramProfileUrl builds the canonical public profile URL', () => {
  assert.equal(instagramProfileUrl('kurocafe'), 'https://www.instagram.com/kurocafe/');
});

/* -------------------------------------------------------------------------- */
/* Grid HTML parsing - hand-written fixtures, no live scraping                */
/* -------------------------------------------------------------------------- */

const OK_GRID_HTML = `
<html><body>
<div class="grid">
  <img src="https://scontent-hkg1-1.cdninstagram.com/v/t51.2885-15/photo1.jpg?_nc_ht=x&amp;_nc_cat=1" alt="Photo 1">
  <img src="https://scontent-hkg1-1.cdninstagram.com/v/t51.2885-15/photo2.jpg?_nc_ht=x" alt="Photo 2">
  <img src="https://scontent-hkg1-1.cdninstagram.com/v/t51.2885-15/photo2.jpg?_nc_ht=x" alt="Photo 2 dup">
  <img src="https://scontent-hkg1-1.cdninstagram.com/v/t51.2885-19/s150x150/profilepic.jpg" alt="profile">
  <img src="/static/bloks/sprite.png" alt="sprite">
</div>
</body></html>`;

const LOGIN_WALL_HTML = `
<html><body>
<form name="loginForm" action="/accounts/login/ajax/">
  <input name="username"><input name="password">
</form>
</body></html>`;

const CONSENT_WALL_HTML = `
<html><body>
<div>Before you continue to Instagram</div>
<button>Allow all cookies</button>
</body></html>`;

const EMPTY_HTML = `<html><body><div>Nothing to see here</div></body></html>`;

test('parseInstagramGridHtml extracts real grid photos, dedupes, and drops the profile pic/sprites', () => {
  const result = parseInstagramGridHtml(OK_GRID_HTML);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.imageUrls, [
    'https://scontent-hkg1-1.cdninstagram.com/v/t51.2885-15/photo1.jpg?_nc_ht=x&_nc_cat=1',
    'https://scontent-hkg1-1.cdninstagram.com/v/t51.2885-15/photo2.jpg?_nc_ht=x',
  ]);
});

test('parseInstagramGridHtml detects a login wall instead of harvesting the form', () => {
  assert.equal(parseInstagramGridHtml(LOGIN_WALL_HTML).status, 'login-wall');
});

test('parseInstagramGridHtml detects a consent wall', () => {
  assert.equal(parseInstagramGridHtml(CONSENT_WALL_HTML).status, 'consent-wall');
});

test('parseInstagramGridHtml reports empty rather than guessing when nothing matches', () => {
  const result = parseInstagramGridHtml(EMPTY_HTML);
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.imageUrls, []);
});

test('limitImageUrls caps to the requested count without reordering', () => {
  assert.deepEqual(limitImageUrls(['a', 'b', 'c', 'd'], 2), ['a', 'b']);
  assert.deepEqual(limitImageUrls(['a'], 5), ['a']);
});

test('gridFailureMessage gives a distinct, non-guessing message per reason', () => {
  const blocked = gridFailureMessage({ reason: 'blocked' }, 'kurocafe');
  assert.match(blocked, /login\/consent wall/);
  assert.match(blocked, /kurocafe/);

  const empty = gridFailureMessage({ reason: 'empty' }, 'kurocafe');
  assert.match(empty, /No public grid photos/);

  const net = gridFailureMessage({ reason: 'network-error', detail: 'ECONNRESET' }, 'kurocafe');
  assert.match(net, /ECONNRESET/);
});

/* -------------------------------------------------------------------------- */
/* fetchInstagramGrid - network call injected, still exercised end-to-end     */
/* -------------------------------------------------------------------------- */

function htmlResponse(status: number, html: string): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } });
}

test('fetchInstagramGrid returns imageUrls on a clean fixture page', async () => {
  const result = await fetchInstagramGrid('kurocafe', { fetchImpl: (async () => htmlResponse(200, OK_GRID_HTML)) as unknown as typeof fetch });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.imageUrls.length, 2);
});

test('fetchInstagramGrid reports "blocked" on a login wall, not an empty success', async () => {
  const result = await fetchInstagramGrid('kurocafe', { fetchImpl: (async () => htmlResponse(200, LOGIN_WALL_HTML)) as unknown as typeof fetch });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'blocked');
});

test('fetchInstagramGrid maps a 403/429 straight to "blocked"', async () => {
  const result = await fetchInstagramGrid('kurocafe', { fetchImpl: (async () => new Response('', { status: 429 })) as unknown as typeof fetch });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'blocked');
});

test('fetchInstagramGrid reports a thrown network error without throwing itself', async () => {
  const result = await fetchInstagramGrid('kurocafe', {
    fetchImpl: (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'network-error');
  assert.match(!result.ok ? (result.detail ?? '') : '', /ENOTFOUND/);
});

/* -------------------------------------------------------------------------- */
/* Filenames / resize width                                                   */
/* -------------------------------------------------------------------------- */

test('harvestFilename is deterministic, zero-padded, and sorts naturally', () => {
  assert.equal(harvestFilename('kuro-cafe', 0), 'kuro-cafe-01.jpg');
  assert.equal(harvestFilename('kuro-cafe', 9), 'kuro-cafe-10.jpg');
  assert.equal(harvestFilename('kuro-cafe', 0, 'png'), 'kuro-cafe-01.png');
});

test('guessExtFromUrl reads a known extension and ignores the query string', () => {
  assert.equal(guessExtFromUrl('https://x.cdninstagram.com/v/photo.jpg?_nc_ht=x'), 'jpg');
  assert.equal(guessExtFromUrl('https://x.cdninstagram.com/v/photo.jpeg'), 'jpg');
  assert.equal(guessExtFromUrl('https://x.cdninstagram.com/v/photo.webp'), 'webp');
});

test('guessExtFromUrl defaults to jpg when the CDN path has no recognisable extension', () => {
  assert.equal(guessExtFromUrl('https://x.cdninstagram.com/v/t51.2885-15/abcown123'), 'jpg');
});

test('computeResizeWidth never upscales a smaller source', () => {
  assert.equal(computeResizeWidth(800, 1600), 800);
});

test('computeResizeWidth caps a larger source at maxWidth', () => {
  assert.equal(computeResizeWidth(4000, 1600), 1600);
});

test('computeResizeWidth falls back to maxWidth when metadata has no usable width', () => {
  assert.equal(computeResizeWidth(0, 1600), 1600);
  assert.equal(computeResizeWidth(Number.NaN, 1600), 1600);
});

/* -------------------------------------------------------------------------- */
/* Curation / menu OCR prompts and schemas                                    */
/* -------------------------------------------------------------------------- */

test('buildCurationPrompt numbers every filename so the model can refer back to them', () => {
  const prompt = buildCurationPrompt('Kuro Cafe', ['kuro-cafe-01.jpg', 'kuro-cafe-02.jpg']);
  assert.match(prompt, /Kuro Cafe/);
  assert.match(prompt, /1\. kuro-cafe-01\.jpg/);
  assert.match(prompt, /2\. kuro-cafe-02\.jpg/);
  assert.match(prompt, /isTimeSensitive/);
});

test('buildMenuOcrPrompt instructs verbatim transcription, not invention', () => {
  const prompt = buildMenuOcrPrompt();
  assert.match(prompt, /do not invent/i);
});

test('CURATION_SCHEMA requires the fields the prompt asks the model to fill', () => {
  assert.deepEqual(CURATION_SCHEMA.required, ['brandVisualLanguage', 'selected']);
  const itemSchema = CURATION_SCHEMA.properties!.selected!.items!;
  assert.deepEqual(itemSchema.required, ['filename', 'isHeroWorthy', 'isTimeSensitive', 'looksLikeMenu', 'description']);
});

test('MENU_OCR_SCHEMA requires name and price on every item', () => {
  const itemSchema = MENU_OCR_SCHEMA.properties!.items!.items!;
  assert.deepEqual(itemSchema.required, ['name', 'price']);
});

/* -------------------------------------------------------------------------- */
/* selectRecommendedFilenames                                                 */
/* -------------------------------------------------------------------------- */

function item(over: Partial<CurationSelectedItem>): CurationSelectedItem {
  return {
    filename: 'x.jpg', isHeroWorthy: false, isTimeSensitive: false, looksLikeMenu: false, description: '',
    ...over,
  };
}

test('selectRecommendedFilenames drops every time-sensitive image outright', () => {
  const items = [
    item({ filename: 'good.jpg' }),
    item({ filename: 'closure-notice.jpg', isTimeSensitive: true }),
  ];
  const picked = selectRecommendedFilenames(items);
  assert.deepEqual(picked, ['good.jpg']);
});

test('selectRecommendedFilenames sorts hero-worthy images first', () => {
  const items = [
    item({ filename: 'plain.jpg' }),
    item({ filename: 'hero.jpg', isHeroWorthy: true }),
  ];
  const picked = selectRecommendedFilenames(items);
  assert.deepEqual(picked, ['hero.jpg', 'plain.jpg']);
});

test('selectRecommendedFilenames caps at max (default 8)', () => {
  const items = Array.from({ length: 12 }, (_, i) => item({ filename: `${i}.jpg` }));
  assert.equal(selectRecommendedFilenames(items).length, 8);
  assert.equal(selectRecommendedFilenames(items, { max: 3 }).length, 3);
});

/* -------------------------------------------------------------------------- */
/* harvestAssets - full pipeline offline, no GEMINI_API_KEY, injected fetch   */
/* -------------------------------------------------------------------------- */

/** A minimal valid 1x1 JPEG so `writeFileSync` produces a real (if trivial)
 *  image file. Real bytes matter here because harvestAssets copies the raw
 *  download straight through when sharp is unavailable. */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFQABAQAAAAAA' +
  'AAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/' +
  'xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

test('harvestAssets downloads images and degrades cleanly with no GEMINI_API_KEY', async () => {
  const websitesRoot = mkdtempSync(join(tmpdir(), 'harvest-test-'));
  try {
    const jpegBytes = Buffer.from(TINY_JPEG_BASE64, 'base64');
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('instagram.com/kurocafe')) return htmlResponse(200, OK_GRID_HTML);
      return new Response(jpegBytes, { status: 200 });
    }) as unknown as typeof fetch;

    const report = await harvestAssets({
      slug: 'kuro-cafe',
      ig: 'kurocafe',
      websitesRoot,
      apiKey: undefined,
      fetchImpl,
      log: () => {},
    });

    assert.equal(report.ok, true);
    assert.equal(report.imagesDownloaded.length, 2);
    assert.equal(report.curation, undefined);
    assert.equal(report.curationSkippedReason, 'GEMINI_API_KEY is not set');
    assert.equal(report.menuSkippedReason, 'curation did not run');
    // Without curation to filter time-sensitive shots, every downloaded
    // photo is still reported so a human can review it manually.
    assert.equal(report.recommendedForSite.length, 2);

    for (const img of report.imagesDownloaded) {
      assert.ok(existsSync(img.path), `expected ${img.path} to exist`);
      assert.ok(readFileSync(img.path).length > 0);
    }
  } finally {
    rmSync(websitesRoot, { recursive: true, force: true });
  }
});

test('harvestAssets reports a login wall clearly instead of writing anything', async () => {
  const websitesRoot = mkdtempSync(join(tmpdir(), 'harvest-test-'));
  try {
    const fetchImpl = (async () => htmlResponse(200, LOGIN_WALL_HTML)) as unknown as typeof fetch;
    const report = await harvestAssets({ slug: 'kuro-cafe', ig: 'kurocafe', websitesRoot, fetchImpl, log: () => {} });
    assert.equal(report.ok, false);
    assert.match(report.message, /login\/consent wall/);
    assert.equal(report.imagesDownloaded.length, 0);
    assert.equal(existsSync(join(websitesRoot, 'kuro-cafe')), false);
  } finally {
    rmSync(websitesRoot, { recursive: true, force: true });
  }
});

test('harvestAssets reports a total download failure without throwing', async () => {
  const websitesRoot = mkdtempSync(join(tmpdir(), 'harvest-test-'));
  try {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('instagram.com/kurocafe')) return htmlResponse(200, OK_GRID_HTML);
      return new Response('nope', { status: 500 });
    }) as unknown as typeof fetch;
    const report = await harvestAssets({ slug: 'kuro-cafe', ig: 'kurocafe', websitesRoot, fetchImpl, log: () => {} });
    assert.equal(report.ok, false);
    assert.match(report.message, /Every download failed/);
  } finally {
    rmSync(websitesRoot, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Limit clamping is exercised through the public option surface              */
/* -------------------------------------------------------------------------- */

test('DEFAULT_LIMIT sits within [MIN_LIMIT, MAX_LIMIT] and matches the documented 10-15 range', () => {
  assert.ok(DEFAULT_LIMIT >= MIN_LIMIT && DEFAULT_LIMIT <= MAX_LIMIT);
  assert.ok(DEFAULT_LIMIT >= 10 && DEFAULT_LIMIT <= 15);
});
