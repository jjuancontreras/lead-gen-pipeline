/**
 * Hero-mockup generator.
 *
 * Design notes:
 *
 * 1. This is the volume asset, not the showcase one. A full walkthrough
 *    (`record.ts`) takes two Playwright takes and two ffmpeg passes to sell
 *    one lead; this produces a single portrait PNG in one page load because
 *    the whole point is throughput - ~50 outreach messages a month, not 10.
 *
 * 2. Portrait, not desktop. The image is read inline in a phone DM, so the
 *    capture targets a 1200x1500 (4:5) canvas rather than a browser-shaped
 *    16:9 crop - a desktop screenshot letterboxed into a phone thread reads
 *    as an attachment nobody resized for you.
 *
 * 3. The hero is measured, not assumed to fill the canvas. A `92vh` hero
 *    captured at a 1500px-tall viewport leaves a gap at the bottom that the
 *    next section - built with `whileInView` - has not revealed yet, so a
 *    slice of it would show mid-animation or fully hidden. The viewport
 *    height is grown once so the hero itself fills the frame; if that still
 *    falls short (a fixed-height hero, say), a DOM spacer matching the page
 *    background is appended below the hero so the canvas fills cleanly
 *    instead of bleeding into unrevealed content.
 *
 * 4. Nothing is written to disk until the pixels are checked. `page.screenshot`
 *    is captured to a buffer, decoded, and measured for variance before
 *    `writeFileSync` ever runs - a blank capture must never overwrite a good
 *    mockup, and it must never leave a bad one behind either.
 *
 * Reuses `record.ts`'s already-solved traps: the `__name` shim for
 * `tsx`/esbuild's `keepNames` reaching `page.evaluate`, and the
 * `:not([hidden])` readiness selector that dodges Next.js's hidden dev
 * overlay.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { Browser } from 'playwright';
import { launch } from './fetcher.ts';
import { WEBSITES_ROOT } from './scaffold.ts';
import {
  assertReachable,
  measureBox,
  pageBackgroundColor,
  resolveDemoUrl,
  visibleTextLength,
  waitForRevealsToSettle,
  waitForSplashToClear,
} from './record.ts';

/* --------------------------------------------------------------------------
 * In-page globals for the one evaluate() this file adds beyond record.ts's
 * (the background-matched spacer). See record.ts's own comment on `lib` -
 * this project targets Node, so DOM types are not ambient and each module
 * that touches the page declares only what it needs.
 * ------------------------------------------------------------------------ */
interface SpacerStyle {
  position: string;
  left: string;
  top: string;
  width: string;
  height: string;
  background: string;
  zIndex: string;
  pointerEvents: string;
}
interface SpacerEl {
  setAttribute(name: string, value: string): void;
  readonly style: SpacerStyle;
}
declare const document: {
  createElement(tag: string): SpacerEl;
  readonly body: { appendChild(el: SpacerEl): void };
  readonly fonts: { readonly ready: Promise<unknown> };
};

/* -------------------------------------------------------------------------- */
/* Output shape                                                               */
/* -------------------------------------------------------------------------- */

export const MOCKUP_WIDTH = 1200;
export const MOCKUP_HEIGHT = 1500;

/** Tried in order; the first match at least this tall (as a fraction of the
 *  viewport) is treated as the hero. `[data-hero]` is a future-proofing hook
 *  the current template does not set - if a template ever adds one, it wins
 *  without a code change here. */
const HERO_SELECTORS: readonly string[] = [
  '[data-hero]',
  'main > *:first-child',
  'body > *:first-child',
];
const HERO_MIN_HEIGHT_RATIO = 0.25;

/** Refuse to grow the capture viewport past this - a hero that would need a
 *  taller viewport than this to fill the frame is not a "short hero", it's a
 *  layout that never fills the frame, and stretching further just wastes
 *  render time chasing it. */
const MAX_CAPTURE_VIEWPORT_HEIGHT = 4000;

/** Below this stddev of luma across the capture, the image reads as a flat
 *  rectangle to a human even if a handful of pixels differ. Chosen well below
 *  the contrast any real hero (text over a photo, or text over the
 *  template's neutral-grey placeholder) produces, and well above pure-noise
 *  JPEG/PNG compression artifacts on a genuinely solid fill. */
const BLANK_STD_DEV_THRESHOLD = 8;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

export function outputPathFor(slug: string, out?: string): string {
  return out ?? join(WEBSITES_ROOT, slug, 'demo', 'hero-mockup.png');
}

/**
 * Given the hero's measured height at `currentHeight`, pick a taller capture
 * viewport so the hero (assumed to scale roughly linearly with viewport
 * height, as any `vh`-based hero does) would fill `targetHeight`. Never
 * shrinks: a hero that already overflows the target is cropped from the top
 * instead, which is a normal hero-image crop, not a broken one.
 */
export function nextViewportHeight(
  currentHeight: number,
  measuredHeroHeight: number,
  targetHeight: number,
  maxHeight = MAX_CAPTURE_VIEWPORT_HEIGHT,
): number {
  if (measuredHeroHeight <= 0) return currentHeight;
  const scaled = Math.round(targetHeight * (currentHeight / measuredHeroHeight));
  return clamp(scaled, currentHeight, maxHeight);
}

/* -------------------------------------------------------------------------- */
/* Minimal PNG decode (colorType 2/6, 8-bit, non-interlaced)                  */
/*                                                                            */
/* Playwright's screenshot() always emits exactly this shape (Chromium's PNG  */
/* encoder does not interlace or drop to a paletted/16-bit form), so a full   */
/* general-purpose decoder would be dead code. This decodes only that shape   */
/* and throws a clear error on anything else, rather than silently           */
/* mis-reading it.                                                           */
/* -------------------------------------------------------------------------- */

export interface DecodedPng {
  width: number;
  height: number;
  /** Flat RGBA, 4 bytes/pixel regardless of the source color type. */
  pixels: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file (bad signature).');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buf.subarray(dataStart, dataStart + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + len + 4; // + CRC
  }

  if (width <= 0 || height <= 0) throw new Error('PNG had no valid IHDR.');
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (expected 8).`);
  if (interlace !== 0) throw new Error('Interlaced PNG not supported.');
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`Unsupported PNG color type ${colorType} (expected 2 or 6).`);
  }

  const srcChannels = colorType === 6 ? 4 : 3;
  const rowBytes = width * srcChannels;
  const raw = inflateSync(Buffer.concat(idatParts));

  const pixels = new Uint8Array(width * height * 4);
  let prevRow = new Uint8Array(rowBytes);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[pos];
    pos++;
    const row = raw.subarray(pos, pos + rowBytes);
    pos += rowBytes;
    const outRow = new Uint8Array(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= srcChannels ? outRow[i - srcChannels]! : 0;
      const b = prevRow[i]!;
      const c = i >= srcChannels ? prevRow[i - srcChannels]! : 0;
      const x = row[i]!;
      let value: number;
      switch (filterType) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + Math.floor((a + b) / 2); break;
        case 4: value = x + paethPredictor(a, b, c); break;
        default: throw new Error(`Unsupported PNG filter type ${filterType}.`);
      }
      outRow[i] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const si = x * srcChannels;
      const di = (y * width + x) * 4;
      pixels[di] = outRow[si]!;
      pixels[di + 1] = outRow[si + 1]!;
      pixels[di + 2] = outRow[si + 2]!;
      pixels[di + 3] = srcChannels === 4 ? outRow[si + 3]! : 255;
    }
    prevRow = outRow;
  }

  return { width, height, pixels };
}

/* -------------------------------------------------------------------------- */
/* Blank-image guard                                                          */
/* -------------------------------------------------------------------------- */

export interface PixelStats {
  mean: number;
  variance: number;
  stdDev: number;
}

/** Standard deviation of luma across the image - low means visually flat. */
export function pixelVariance(pixels: Uint8Array, width: number, height: number): PixelStats {
  const n = width * height;
  if (n === 0) return { mean: 0, variance: 0, stdDev: 0 };
  let sum = 0;
  const luma = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const l = 0.299 * pixels[o]! + 0.587 * pixels[o + 1]! + 0.114 * pixels[o + 2]!;
    luma[i] = l;
    sum += l;
  }
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = luma[i]! - mean;
    sq += d * d;
  }
  const variance = sq / n;
  return { mean, variance, stdDev: Math.sqrt(variance) };
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                    */
/* -------------------------------------------------------------------------- */

export interface MockupOptions {
  slug: string;
  url?: string;
  outPath?: string;
  headed?: boolean;
  log?: (msg: string) => void;
}

export interface MockupReport {
  slug: string;
  url: string;
  outPath: string;
  width: number;
  height: number;
  bytes: number;
  /** Which selector located the hero, or null if the plain-viewport fallback
   *  was used because nothing tall enough was found. */
  heroSelector: string | null;
  splashCleared: boolean;
  revealsSettled: boolean;
  /** True if a background-matched spacer was appended below a short hero. */
  padded: boolean;
  paddedPx: number;
  pixelStdDev: number;
  visibleTextLength: number;
}

async function captureMockup(
  browser: Browser,
  slug: string,
  url: string,
  outPath: string,
  log: (msg: string) => void,
): Promise<MockupReport> {
  const ctx = await browser.newContext({
    viewport: { width: MOCKUP_WIDTH, height: MOCKUP_HEIGHT },
    deviceScaleFactor: 1,
    locale: 'en-PH',
    timezoneId: 'Asia/Manila',
    // The entrance reveal is the thing being sold; a reduced-motion default
    // inherited from the host would freeze it at its initial (hidden) frame.
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();

  // tsx/esbuild's keepNames wraps functions in a `__name` helper that
  // Playwright's serialized evaluate() callbacks then reference on the page,
  // where it does not exist. Shim it before any page script runs - copied
  // from record.ts, which hit this first.
  await page.addInitScript(() => {
    (globalThis as unknown as { __name?: unknown }).__name ??= <T,>(fn: T): T => fn;
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // Next.js dev injects a hidden overlay div as body's first child, so a
    // bare `body > *` visibility wait never resolves. Copied from record.ts.
    await page.waitForSelector('main:not([hidden]), body > *:not([hidden]):not(script):not(style)', {
      state: 'visible',
      timeout: 20_000,
    });
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(200);

    const splashCleared = await waitForSplashToClear(page);
    if (!splashCleared) log('splash overlay never cleared - capturing anyway');

    const revealsSettled = await waitForRevealsToSettle(page, { timeoutMs: 8000 });
    if (!revealsSettled) {
      log('entrance animation did not settle within 8s - capturing anyway (may show a mid-fade frame)');
    }

    let box = await measureBox(page, HERO_SELECTORS, HERO_MIN_HEIGHT_RATIO);
    if (box) {
      const grownHeight = nextViewportHeight(MOCKUP_HEIGHT, box.height, MOCKUP_HEIGHT);
      if (grownHeight !== MOCKUP_HEIGHT) {
        await page.setViewportSize({ width: MOCKUP_WIDTH, height: grownHeight });
        // Let layout (vh-based sizing) and any resize-driven framer-motion
        // recalculation settle before remeasuring.
        await page.waitForTimeout(200);
        box = await measureBox(page, HERO_SELECTORS, HERO_MIN_HEIGHT_RATIO);
      }
    } else {
      log('no hero-shaped element found - falling back to a plain viewport clip');
    }

    let padded = false;
    let paddedPx = 0;
    if (box) {
      const shortBy = MOCKUP_HEIGHT - box.height;
      if (shortBy > 0) {
        const bgColor = await pageBackgroundColor(page);
        // A short hero would otherwise be filled by whatever the next
        // section is - built with `whileInView` and not revealed at scroll
        // position 0, so it would show hidden or mid-animation. A flat
        // spacer in the page's own background color reads as intentional
        // negative space instead.
        await page.evaluate(
          ({ top, spacerHeight, color }) => {
            const spacer = document.createElement('div');
            spacer.setAttribute('data-mockup-spacer', '1');
            spacer.style.position = 'absolute';
            spacer.style.left = '0';
            spacer.style.top = `${top}px`;
            spacer.style.width = '100%';
            spacer.style.height = `${spacerHeight}px`;
            spacer.style.background = color;
            spacer.style.zIndex = '9999';
            spacer.style.pointerEvents = 'none';
            document.body.appendChild(spacer);
          },
          { top: box.y + box.height, spacerHeight: shortBy, color: bgColor },
        );
        padded = true;
        paddedPx = shortBy;
      }
    }

    const clipTop = box?.y ?? 0;
    const buffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: clipTop, width: MOCKUP_WIDTH, height: MOCKUP_HEIGHT },
    });

    const decoded = decodePng(buffer);
    const stats = pixelVariance(decoded.pixels, decoded.width, decoded.height);
    const textLength = await visibleTextLength(page);

    if (stats.stdDev < BLANK_STD_DEV_THRESHOLD || textLength === 0) {
      throw new Error(
        `Refusing to write ${outPath}: the capture looks blank ` +
        `(pixel stddev ${stats.stdDev.toFixed(2)}, page text length ${textLength}). ` +
        'The hero likely failed to render, the entrance animation never fired, ' +
        'or the dev server is serving an empty page.',
      );
    }

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buffer);

    return {
      slug,
      url,
      outPath,
      width: decoded.width,
      height: decoded.height,
      bytes: statSync(outPath).size,
      heroSelector: box?.selector ?? null,
      splashCleared,
      revealsSettled,
      padded,
      paddedPx,
      pixelStdDev: stats.stdDev,
      visibleTextLength: textLength,
    };
  } finally {
    await ctx.close();
  }
}

/** Generate a 1200x1500 hero mockup for one demo site. Does not start the
 *  dev server - see `assertReachable`'s hint if it is not already running. */
export async function generateMockup(opts: MockupOptions): Promise<MockupReport> {
  const log = opts.log ?? (() => {});

  let port: number | null = null;
  let url = opts.url;
  if (!url) {
    const resolved = resolveDemoUrl(opts.slug);
    url = resolved.url;
    port = resolved.port;
  }
  await assertReachable(url, opts.slug, port);

  const outPath = outputPathFor(opts.slug, opts.outPath);
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });

  const browser = await launch(!opts.headed);
  try {
    return await captureMockup(browser, opts.slug, url, outPath, log);
  } finally {
    await browser.close();
  }
}
