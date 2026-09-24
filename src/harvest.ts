/**
 * Asset harvest: pull a business's own public Instagram photos, curate and
 * caption them with Gemini vision, and hand back a report ready for
 * DESIGN.md and content.json.
 *
 * Only PUBLIC business data ever reaches Gemini here - a public grid image,
 * downloaded by this script. Never a client contract, an inbox, or anything
 * from behind a login. Free-tier Gemini content is used to improve Google's
 * products, so that boundary matters (see src/gemini.ts header).
 *
 * Known-working scrape method (from this user's own notes): a public
 * Instagram profile's grid `<img>` `src` attributes are directly curl-able
 * signed scontent.cdninstagram.com URLs, PROVIDED the request carries a
 * browser User-Agent and a Referer header. No login, no API key, no
 * Playwright - Instagram walls aggressively on anything that looks scripted,
 * so on a block this reports the wall rather than guessing or retrying blind.
 */
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { generateFromImages, type JsonSchema, type GeminiResult } from './gemini.ts';
import { USER_AGENT } from './browser-identity.ts';

const REFERER = 'https://www.instagram.com/';

export const DEFAULT_LIMIT = 12;
export const MIN_LIMIT = 4;
export const MAX_LIMIT = 20;
/** Final resized width. Matches the "hero" tier in the demo template's own
 *  optimizer (templates/demo-site/scripts/optimize-images.mjs uses 1920 for
 *  brand assets, 1200 for food shots) - harvested photos land in the middle
 *  since we do not yet know which role each will play. */
export const DEFAULT_MAX_WIDTH = 1600;
export const JPEG_QUALITY = 82;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/* -------------------------------------------------------------------------- */
/* Handle / URL parsing (pure)                                                */
/* -------------------------------------------------------------------------- */

/** Accepts "@kurocafe", "kurocafe", or any instagram.com profile URL and
 *  returns the bare lowercase handle. Throws on anything that is not
 *  shaped like a handle - a caller mistyping a handle should see that
 *  immediately, not have it silently mangled into a wrong profile. */
export function normalizeIgInput(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new Error('--ig is required: a handle like "kurocafe" or a profile URL.');

  const urlMatch = /instagram\.com\/([^/?#]+)/i.exec(trimmed);
  const raw = urlMatch ? urlMatch[1]! : trimmed.replace(/^@/, '');
  const handle = raw.trim().toLowerCase();

  if (!/^[a-z0-9._]{1,30}$/.test(handle)) {
    throw new Error(`"${input}" does not look like a valid Instagram handle or profile URL.`);
  }
  return handle;
}

export function instagramProfileUrl(handle: string): string {
  return `https://www.instagram.com/${handle}/`;
}

/* -------------------------------------------------------------------------- */
/* Grid HTML parsing (pure - unit tested against hand-written fixture HTML)   */
/* -------------------------------------------------------------------------- */

export type GridStatus = 'ok' | 'login-wall' | 'consent-wall' | 'empty';

export interface GridParseResult {
  status: GridStatus;
  imageUrls: string[];
}

function decodeHtmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Login and consent walls both render a real page - detecting them is a
 *  text match, not an HTTP status, so a naive "200 OK means we have data"
 *  check would happily parse a login form for photos. */
function detectWall(html: string): 'login-wall' | 'consent-wall' | null {
  if (/name="loginForm"|Log in to see photos and videos|accounts\/login\/\?/i.test(html)) {
    return 'login-wall';
  }
  if (/Allow (all )?cookies|Before you continue to Instagram|consent\.instagram\.com/i.test(html)) {
    return 'consent-wall';
  }
  return null;
}

const IMG_SRC_RE = /<img[^>]+src="([^"]+)"/gi;

/** Grid photos vs. everything else that also happens to live on
 *  cdninstagram.com - the profile picture, sprites, and small thumbnail
 *  variants of the very same photos. Excluding by known small-size markers
 *  is conservative on purpose: a false positive here silently drops a real
 *  photo, a false negative just means one extra download to dedupe against. */
function isGridPhotoUrl(url: string): boolean {
  if (!/cdninstagram\.com/i.test(url) || !/scontent/i.test(url)) return false;
  if (/profile_pic|s150x150|s32x32|150x150|44x44/i.test(url)) return false;
  return true;
}

export function parseInstagramGridHtml(html: string): GridParseResult {
  const wall = detectWall(html);
  if (wall) return { status: wall, imageUrls: [] };

  const seen = new Set<string>();
  const imageUrls: string[] = [];
  for (const m of html.matchAll(IMG_SRC_RE)) {
    const url = decodeHtmlEntities(m[1] ?? '');
    if (!isGridPhotoUrl(url) || seen.has(url)) continue;
    seen.add(url);
    imageUrls.push(url);
  }
  return { status: imageUrls.length > 0 ? 'ok' : 'empty', imageUrls };
}

export function limitImageUrls(urls: readonly string[], limit: number): string[] {
  return urls.slice(0, Math.max(0, limit));
}

/** Human-readable reason for a failed/empty grid fetch. Kept separate from
 *  the network call so the exact wording is unit-tested without a fetch. */
export function gridFailureMessage(
  outcome: { reason: 'blocked' | 'empty' | 'network-error'; detail?: string },
  handle: string,
): string {
  switch (outcome.reason) {
    case 'blocked':
      return (
        `Instagram showed a login/consent wall for @${handle}. Not guessing past it - ` +
        `open the profile in a browser, confirm it is public, and retry later.`
      );
    case 'empty':
      return `No public grid photos found for @${handle}. The account may be private or have no posts.`;
    case 'network-error':
      return `Could not reach Instagram: ${outcome.detail ?? 'unknown network error'}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Filenames                                                                  */
/* -------------------------------------------------------------------------- */

/** Deterministic, sortable, and readable in a file browser: "kuro-cafe-01.jpg". */
export function harvestFilename(slug: string, index: number, ext = 'jpg'): string {
  return `${slug}-${String(index + 1).padStart(2, '0')}.${ext}`;
}

/** Best-effort extension for a raw download before it is normalised to jpg
 *  by the optimizer. Instagram's CDN paths do not reliably end in an
 *  extension, so this is a hint, not a guarantee. */
export function guessExtFromUrl(url: string): string {
  const clean = url.split('?')[0] ?? url;
  const ext = extname(clean).replace('.', '').toLowerCase();
  return /^(jpg|jpeg|png|webp)$/.test(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : 'jpg';
}

/* -------------------------------------------------------------------------- */
/* Resize width selection (pure)                                              */
/* -------------------------------------------------------------------------- */

/** Never upscale a smaller source, mirroring
 *  templates/demo-site/scripts/optimize-images.mjs's own resize logic. */
export function computeResizeWidth(actualWidth: number, maxWidth: number): number {
  if (!Number.isFinite(actualWidth) || actualWidth <= 0) return maxWidth;
  return Math.min(Math.round(actualWidth), maxWidth);
}

/* -------------------------------------------------------------------------- */
/* Gemini curation + menu OCR: schemas and prompts (pure)                     */
/* -------------------------------------------------------------------------- */

export interface CurationSelectedItem {
  filename: string;
  isHeroWorthy: boolean;
  isTimeSensitive: boolean;
  looksLikeMenu: boolean;
  description: string;
}

export interface CurationResult {
  brandVisualLanguage: string;
  selected: CurationSelectedItem[];
}

export const CURATION_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['brandVisualLanguage', 'selected'],
  properties: {
    brandVisualLanguage: {
      type: 'string',
      description: 'One to three sentences describing this brand\'s visual language, ready to paste into DESIGN.md.',
    },
    selected: {
      type: 'array',
      items: {
        type: 'object',
        required: ['filename', 'isHeroWorthy', 'isTimeSensitive', 'looksLikeMenu', 'description'],
        properties: {
          filename: { type: 'string' },
          isHeroWorthy: { type: 'boolean' },
          isTimeSensitive: {
            type: 'boolean',
            description: 'True for a dated closure notice, a one-off event flyer, or anything else time-bound.',
          },
          looksLikeMenu: { type: 'boolean', description: 'True if this image is a menu or price-list graphic.' },
          description: { type: 'string' },
        },
      },
    },
  },
};

export function buildCurationPrompt(businessName: string, filenames: readonly string[]): string {
  const list = filenames.map((f, i) => `${i + 1}. ${f}`).join('\n');
  return (
    `You are reviewing public Instagram photos for the small business "${businessName}" ` +
    `ahead of building them a pitch website. The images are attached in this order:\n${list}\n\n` +
    `For every image, using its exact filename from the list above, judge whether it is worth ` +
    `using on the site. Flag any image that would make the site look out of date the moment it ` +
    `is not updated (a dated closure notice, an event flyer with a specific date, a holiday ` +
    `promo) as isTimeSensitive. Flag any image that is a menu or price list as looksLikeMenu. ` +
    `Also describe the brand's overall visual language across these photos - colours, lighting, ` +
    `mood, composition style - in language that could be pasted straight into a design brief.`
  );
}

export interface MenuItem {
  name: string;
  price: string;
  description?: string;
}

export interface MenuOcrResult {
  currency: string;
  items: MenuItem[];
}

export const MENU_OCR_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['currency', 'items'],
  properties: {
    currency: { type: 'string', description: 'e.g. "PHP", or "" if not shown.' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'price'],
        properties: {
          name: { type: 'string' },
          price: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
};

export function buildMenuOcrPrompt(): string {
  return (
    'These images are menu or price-list graphics posted by a small business on their public ' +
    'Instagram. Transcribe every item and its price exactly as printed - do not invent, round, ' +
    'or translate anything. If an item has no visible price, still list it with price "".'
  );
}

/** Hero-worthy first, time-sensitive images dropped entirely - the whole
 *  point of flagging them is that they must not end up on the site. */
export function selectRecommendedFilenames(
  items: readonly CurationSelectedItem[],
  opts: { max?: number } = {},
): string[] {
  const max = opts.max ?? 8;
  return [...items]
    .filter((i) => !i.isTimeSensitive)
    .sort((a, b) => Number(b.isHeroWorthy) - Number(a.isHeroWorthy))
    .slice(0, max)
    .map((i) => i.filename);
}

/* -------------------------------------------------------------------------- */
/* Network: grid fetch + image download (thin I/O, not unit-tested directly - */
/* every decision above it is)                                                */
/* -------------------------------------------------------------------------- */

export type GridFetchOutcome =
  | { ok: true; imageUrls: string[] }
  | { ok: false; reason: 'blocked' | 'empty' | 'network-error'; detail?: string };

export async function fetchInstagramGrid(
  handle: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GridFetchOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(instagramProfileUrl(handle), {
      headers: { 'user-agent': USER_AGENT, referer: REFERER, 'accept-language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (err) {
    return { ok: false, reason: 'network-error', detail: (err as Error).message };
  }
  if (!res.ok) {
    return { ok: false, reason: res.status === 429 || res.status === 403 ? 'blocked' : 'network-error', detail: `HTTP ${res.status}` };
  }
  const html = await res.text();
  const parsed = parseInstagramGridHtml(html);
  if (parsed.status === 'login-wall' || parsed.status === 'consent-wall') {
    return { ok: false, reason: 'blocked', detail: parsed.status };
  }
  if (parsed.status === 'empty') return { ok: false, reason: 'empty' };
  return { ok: true, imageUrls: parsed.imageUrls };
}

async function downloadOne(url: string, destPath: string, fetchImpl: typeof fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, referer: REFERER },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const bytes = Buffer.from(await res.arrayBuffer());
    writeFileSync(destPath, bytes);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* -------------------------------------------------------------------------- */
/* sharp resize (optional dependency, guarded)                                */
/* -------------------------------------------------------------------------- */

/** The handful of `sharp` methods this module actually calls. `sharp` is not
 *  a devDependency here (it is only installed under templates/demo-site),
 *  and src/harvest.ts must not touch package.json - so the module is loaded
 *  by a non-literal specifier, which TypeScript cannot resolve statically
 *  and therefore does not try to typecheck against a missing package. This
 *  interface is what keeps the *usage* of the result type-safe instead. */
interface SharpImage {
  metadata(): Promise<{ width?: number; height?: number }>;
  resize(opts: { width: number }): SharpImage;
  jpeg(opts: { quality: number; mozjpeg?: boolean }): SharpImage;
  toFile(path: string): Promise<unknown>;
}
type SharpFactory = (path: string) => SharpImage;

/** Loaded lazily and only once so a missing install degrades to a single
 *  clear note rather than one failed import per image. */
let sharpModulePromise: Promise<SharpFactory | null> | null = null;
async function loadSharp(): Promise<SharpFactory | null> {
  const specifier = 'sharp';
  sharpModulePromise ??= import(specifier)
    .then((m: { default?: SharpFactory } & SharpFactory) => (m.default ?? m) as SharpFactory)
    .catch(() => null);
  return sharpModulePromise;
}

async function optimizeImage(
  srcPath: string,
  destPath: string,
  maxWidth: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sharp = await loadSharp();
  if (!sharp) return { ok: false, error: 'sharp-unavailable' };
  try {
    const img = sharp(srcPath);
    const meta = await img.metadata();
    const width = computeResizeWidth(meta.width ?? maxWidth, maxWidth);
    await img.resize({ width }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toFile(destPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

export interface HarvestOptions {
  slug: string;
  ig: string;
  businessName?: string;
  limit?: number;
  websitesRoot: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export interface HarvestedImage {
  filename: string;
  path: string;
  sourceUrl: string;
  optimized: boolean;
}

export interface HarvestReport {
  ok: boolean;
  slug: string;
  handle: string;
  outDir: string;
  imagesDownloaded: HarvestedImage[];
  imagesFailed: { url: string; error: string }[];
  optimizerAvailable: boolean;
  curation?: CurationResult;
  curationSkippedReason?: string;
  menu?: MenuOcrResult;
  menuSkippedReason?: string;
  recommendedForSite: string[];
  message: string;
}

/**
 * Full pipeline: grid -> download -> optimize -> (guarded) curate -> (guarded)
 * OCR any flagged menu graphics. Never throws for an expected failure mode -
 * a wall, a missing key, a missing `sharp` install all come back as a report
 * field, so a caller (the CLI) can print a clear message and exit non-zero
 * without a stack trace.
 */
export async function harvestAssets(opts: HarvestOptions): Promise<HarvestReport> {
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = clamp(opts.limit ?? DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
  const handle = normalizeIgInput(opts.ig);
  const outDir = join(opts.websitesRoot, opts.slug, 'research', 'images', 'instagram');
  const notesDir = join(opts.websitesRoot, opts.slug, 'research', 'notes');

  log(`fetching public grid for @${handle}`);
  const grid = await fetchInstagramGrid(handle, { fetchImpl });
  if (!grid.ok) {
    return {
      ok: false, slug: opts.slug, handle, outDir,
      imagesDownloaded: [], imagesFailed: [], optimizerAvailable: false,
      recommendedForSite: [],
      message: gridFailureMessage(grid, handle),
    };
  }

  const urls = limitImageUrls(grid.imageUrls, limit);
  log(`found ${grid.imageUrls.length} grid photos, downloading ${urls.length}`);

  mkdirSync(outDir, { recursive: true });
  const rawDir = await mkdtemp(join(tmpdir(), 'harvest-raw-'));

  const downloaded: HarvestedImage[] = [];
  const failed: { url: string; error: string }[] = [];
  const sharp = await loadSharp();

  try {
    for (const [i, url] of urls.entries()) {
      const rawExt = guessExtFromUrl(url);
      const rawPath = join(rawDir, `raw-${i}.${rawExt}`);
      const dl = await downloadOne(url, rawPath, fetchImpl);
      if (!dl.ok) {
        failed.push({ url, error: dl.error });
        continue;
      }
      const filename = harvestFilename(opts.slug, i);
      const destPath = join(outDir, filename);
      const optimized = sharp ? await optimizeImage(rawPath, destPath, DEFAULT_MAX_WIDTH) : { ok: false as const, error: 'sharp-unavailable' };
      if (!optimized.ok) {
        // Degrade gracefully: ship the original bytes under the same naming
        // scheme rather than losing the download outright.
        copyFileSync(rawPath, destPath);
      }
      downloaded.push({ filename, path: destPath, sourceUrl: url, optimized: optimized.ok });
    }
  } finally {
    rmSync(rawDir, { recursive: true, force: true });
  }

  if (!sharp) {
    log('sharp is not installed in this package - images were saved unresized. See report for the dependency to add.');
  }
  if (downloaded.length === 0) {
    return {
      ok: false, slug: opts.slug, handle, outDir,
      imagesDownloaded: [], imagesFailed: failed, optimizerAvailable: Boolean(sharp),
      recommendedForSite: [],
      message: `Every download failed (${failed.length}/${urls.length}). ${failed[0]?.error ?? ''}`,
    };
  }

  mkdirSync(notesDir, { recursive: true });
  const businessName = opts.businessName ?? opts.slug.replace(/-/g, ' ');

  let curation: CurationResult | undefined;
  let curationSkippedReason: string | undefined;
  const curationCall = await generateFromImages<CurationResult>({
    apiKey: opts.apiKey,
    imagePaths: downloaded.map((d) => d.path),
    prompt: buildCurationPrompt(businessName, downloaded.map((d) => d.filename)),
    schema: CURATION_SCHEMA,
  });
  if (curationCall.ok) {
    curation = curationCall.data;
    writeFileSync(join(notesDir, 'curation.json'), JSON.stringify(curation, null, 2) + '\n');
  } else {
    curationSkippedReason = curationSkipMessage(curationCall);
    log(`curation skipped: ${curationSkippedReason}`);
  }

  let menu: MenuOcrResult | undefined;
  let menuSkippedReason: string | undefined;
  const menuFilenames = curation?.selected.filter((s) => s.looksLikeMenu).map((s) => s.filename) ?? [];
  if (menuFilenames.length === 0) {
    menuSkippedReason = curation ? 'no images were flagged as a menu/price graphic' : 'curation did not run';
  } else {
    const menuPaths = downloaded.filter((d) => menuFilenames.includes(d.filename)).map((d) => d.path);
    const menuCall = await generateFromImages<MenuOcrResult>({
      apiKey: opts.apiKey,
      imagePaths: menuPaths,
      prompt: buildMenuOcrPrompt(),
      schema: MENU_OCR_SCHEMA,
    });
    if (menuCall.ok) {
      menu = menuCall.data;
      writeFileSync(join(notesDir, 'menu.json'), JSON.stringify(menu, null, 2) + '\n');
    } else {
      menuSkippedReason = curationSkipMessage(menuCall);
      log(`menu OCR skipped: ${menuSkippedReason}`);
    }
  }

  const recommendedForSite = curation
    ? selectRecommendedFilenames(curation.selected)
    : downloaded.map((d) => d.filename);

  const messageParts = [`downloaded ${downloaded.length}/${urls.length} photos to ${outDir}`];
  if (failed.length) messageParts.push(`${failed.length} download(s) failed`);
  if (!sharp) messageParts.push('sharp not installed - images were not resized/optimized');
  if (!curation) messageParts.push(`curation skipped (${curationSkippedReason})`);
  if (!menu) messageParts.push(`menu OCR skipped (${menuSkippedReason})`);

  return {
    ok: true, slug: opts.slug, handle, outDir,
    imagesDownloaded: downloaded, imagesFailed: failed, optimizerAvailable: Boolean(sharp),
    curation, curationSkippedReason, menu, menuSkippedReason,
    recommendedForSite,
    message: messageParts.join('; '),
  };
}

function curationSkipMessage(result: GeminiResult<unknown>): string {
  if (result.ok) return '';
  if (result.reason === 'no-api-key') return 'GEMINI_API_KEY is not set';
  return `${result.reason}: ${result.detail}`;
}

