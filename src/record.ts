/**
 * Automated demo walkthrough recorder.
 *
 * Design notes:
 *
 * 1. The demo sites reveal their content on scroll (framer-motion
 *    `whileInView`). A full-page capture, or a scroll that outruns the
 *    reveals, shows a page that has already settled - which reads as dead.
 *    So the descent pauses at every section boundary, and the reveal is
 *    *verified* rather than assumed: opacity is sampled on arrival and again
 *    after the pause, and a section that was hidden and is now shown counts
 *    as a reveal that fired on camera.
 *
 * 2. Two takes, not one crop. Email wants 1920x1080; a Messenger or Instagram
 *    DM wants 1080x1920. Cropping the desktop take to portrait yields a
 *    letterboxed slice of a desktop layout, which looks broken. The portrait
 *    take is recorded at a mobile viewport so the site renders its own mobile
 *    layout, then scaled and padded onto the 9:16 canvas.
 *
 * 3. Playwright only writes WebM. Messenger, Instagram and QuickTime all need
 *    H.264 in yuv420p - without `-pix_fmt yuv420p` the file plays in a browser
 *    and nowhere the client actually is.
 *
 * 4. Nothing here starts a dev server. Owning the server lifetime means owning
 *    its failure modes; an unreachable URL is reported with the command to run
 *    instead.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { launch } from './fetcher.ts';
import { WEBSITES_ROOT } from './scaffold.ts';

const execFileAsync = promisify(execFile);

/* --------------------------------------------------------------------------
 * In-page globals.
 *
 * tsconfig's `lib` is ES2023 because this is a Node project; pulling in the
 * DOM lib would put browser globals in scope for every module under `src/`.
 * These module-scoped declarations cover exactly what the `page.evaluate`
 * callbacks below touch, so the in-page code stays type-checked.
 * ------------------------------------------------------------------------ */
interface PageRect {
  top: number; bottom: number; left: number; right: number; width: number; height: number;
}
interface PageEl {
  readonly tagName: string;
  getBoundingClientRect(): PageRect;
}
interface PageStyle {
  readonly opacity: string;
  readonly transform: string;
  readonly backgroundColor: string;
  readonly overflow: string;
  readonly position: string;
}
declare const document: {
  querySelectorAll(selector: string): ArrayLike<PageEl>;
  querySelector(selector: string): PageEl | null;
  readonly body: PageEl & { readonly innerText: string };
  readonly documentElement: { readonly scrollHeight: number };
  readonly fonts: { readonly ready: Promise<unknown> };
};
declare const window: {
  readonly scrollY: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  scrollTo(options: { top: number; behavior: string }): void;
  getComputedStyle(el: PageEl): PageStyle;
};

/* -------------------------------------------------------------------------- */
/* Format specs                                                               */
/* -------------------------------------------------------------------------- */

export type VideoFormat = '16x9' | '9x16';
export const VIDEO_FORMATS: readonly VideoFormat[] = ['16x9', '9x16'];

export interface FormatSpec {
  readonly out: { width: number; height: number };
  /** Browser viewport. The 9:16 take uses a phone viewport so the site renders
   *  its mobile layout - the desktop take must never just be cropped. */
  readonly viewport: { width: number; height: number };
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly channel: string;
}

export const FORMATS: Record<VideoFormat, FormatSpec> = {
  '16x9': {
    out: { width: 1920, height: 1080 },
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    channel: 'email',
  },
  '9x16': {
    out: { width: 1080, height: 1920 },
    viewport: { width: 390, height: 844 },
    // Capture at 2x so upscaling a 390px-wide take to a 1080px-wide canvas
    // resamples real pixels instead of inventing them.
    deviceScaleFactor: 2,
    isMobile: true,
    channel: 'Instagram / Messenger DM',
  },
};

/* -------------------------------------------------------------------------- */
/* Walkthrough planning (pure - unit tested)                                  */
/* -------------------------------------------------------------------------- */

/** Pause at each section, long enough for a reveal to play and be read. */
export const MIN_DWELL_MS = 1200;
export const MAX_DWELL_MS = 1800;
/** Only reached on pages too short to fill MIN_TOTAL_MS at MAX_DWELL_MS. */
export const HARD_MAX_DWELL_MS = 3200;
const MID_DWELL_MS = 1500;
/** Smooth-scroll travel plus the settle poll, measured against the template. */
const SCROLL_TRAVEL_MS = 900;
/** The hero's entrance animation runs ~1.1s; this lets it finish on camera. */
const INTRO_HOLD_MS = 2600;
const OUTRO_EXTRA_MS = 1200;
export const TARGET_MS = 27_000;
export const MIN_TOTAL_MS = 20_000;
export const MAX_TOTAL_MS = 35_000;
const MIN_STOPS = 3;
const MAX_STOPS = 14;
/** Section tops closer than this are the same stop. */
const MERGE_PX = 32;
/** No single jump may exceed about one screen - a longer one is a blur. */
const MAX_STEP_RATIO = 1.1;
/** Below this a step is a nudge rather than a move, and looks like a stutter. */
const STEP_FLOOR_RATIO = 0.28;
const MIN_STEP_PX = 140;

export interface Stop {
  /** Document-space scroll offset. */
  y: number;
  dwellMs: number;
}

export interface WalkPlan {
  stops: Stop[];
  estimatedMs: number;
  /** The page was too short to reach MIN_TOTAL_MS inside the normal dwell band. */
  stretched: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

function dedupe(sorted: readonly number[], mergePx: number): number[] {
  const out: number[] = [];
  for (const y of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || y - last > mergePx) out.push(y);
  }
  return out;
}

/** Split any gap longer than `maxStep` into equal sub-steps. */
function capSteps(ys: readonly number[], maxStep: number): number[] {
  const first = ys[0];
  if (first === undefined || maxStep <= 0) return [...ys];
  const out: number[] = [first];
  for (let i = 1; i < ys.length; i++) {
    const prev = ys[i - 1]!;
    const next = ys[i]!;
    const gap = next - prev;
    if (gap > maxStep) {
      const steps = Math.ceil(gap / maxStep);
      for (let s = 1; s < steps; s++) out.push(Math.round(prev + (gap * s) / steps));
    }
    out.push(next);
  }
  return out;
}

/** Repeatedly halve the widest remaining gap until `want` stops or the floor. */
function subdivideTo(ys: readonly number[], want: number, floorStep: number): number[] {
  const out = [...ys];
  while (out.length < want) {
    let bestIdx = -1;
    let bestGap = 0;
    for (let i = 1; i < out.length; i++) {
      const gap = out[i]! - out[i - 1]!;
      if (gap > bestGap) { bestGap = gap; bestIdx = i; }
    }
    // The widest gap is the only one worth splitting; if half of it is already
    // below the floor, every other gap is too.
    if (bestIdx === -1 || bestGap / 2 < floorStep) break;
    out.splice(bestIdx, 0, Math.round(out[bestIdx - 1]! + bestGap / 2));
  }
  return out;
}

function sampleEvenly(ys: readonly number[], count: number): number[] {
  if (count >= ys.length || count < 2) return [...ys];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(ys[Math.round((i * (ys.length - 1)) / (count - 1))]!);
  }
  return dedupe(out, 0);
}

const totalFor = (n: number, dwellMs: number) =>
  INTRO_HOLD_MS + OUTRO_EXTRA_MS + (n - 1) * (SCROLL_TRAVEL_MS + dwellMs);

const dwellFor = (n: number, targetMs: number) =>
  n <= 1
    ? MIN_DWELL_MS
    : (targetMs - INTRO_HOLD_MS - OUTRO_EXTRA_MS - (n - 1) * SCROLL_TRAVEL_MS) / (n - 1);

/**
 * Turn measured section boundaries into a paced descent.
 *
 * Section count alone does not decide the runtime: a four-section page would
 * finish in twelve seconds and a twenty-section page would run for two
 * minutes. So the plan works backwards from the target runtime - subdividing
 * long gaps when there are too few sections, dropping stops when there are too
 * many - and only then fits the dwell.
 */
export function planWalkthrough(
  sectionTops: readonly number[],
  layout: { pageHeight: number; viewportHeight: number },
  opts: { targetMs?: number; minTotalMs?: number } = {},
): WalkPlan {
  const target = opts.targetMs ?? TARGET_MS;
  // A smoke test wants a few seconds, not twenty; the default is unchanged.
  const floor = Math.min(opts.minTotalMs ?? MIN_TOTAL_MS, MIN_TOTAL_MS);
  const vh = Math.max(1, Math.round(layout.viewportHeight));
  const maxScroll = Math.max(0, Math.round(layout.pageHeight - vh));

  const raw = [0, ...sectionTops, maxScroll]
    .map((y) => clamp(Math.round(y), 0, maxScroll))
    .sort((a, b) => a - b);
  let ys = dedupe(raw, MERGE_PX);
  // dedupe keeps the first of a cluster, which could leave the last stop short
  // of the page bottom. The walk must end at the footer.
  if (ys.length > 0) ys[ys.length - 1] = maxScroll;

  ys = capSteps(ys, vh * MAX_STEP_RATIO);

  const wantStops = clamp(
    Math.round((target - INTRO_HOLD_MS - OUTRO_EXTRA_MS) / (MID_DWELL_MS + SCROLL_TRAVEL_MS)) + 1,
    MIN_STOPS,
    MAX_STOPS,
  );
  ys = subdivideTo(ys, wantStops, Math.max(MIN_STEP_PX, vh * STEP_FLOOR_RATIO));
  if (ys.length > MAX_STOPS) ys = sampleEvenly(ys, MAX_STOPS);

  let dwell = clamp(dwellFor(ys.length, target), MIN_DWELL_MS, MAX_DWELL_MS);
  if (totalFor(ys.length, dwell) > MAX_TOTAL_MS) {
    dwell = MIN_DWELL_MS;
    while (ys.length > MIN_STOPS && totalFor(ys.length, dwell) > MAX_TOTAL_MS) {
      ys = sampleEvenly(ys, ys.length - 1);
    }
  }

  let total = totalFor(ys.length, dwell);
  let stretched = false;
  // A short page cannot fill twenty seconds of scrolling. Holding longer on
  // each section reads as deliberate; padding the head or tail with a static
  // frame reads as a broken video - so the dwell band gives before the
  // runtime floor does.
  if (total < floor && ys.length > 1) {
    dwell = Math.min(HARD_MAX_DWELL_MS, dwell + (floor - total) / (ys.length - 1));
    total = totalFor(ys.length, dwell);
    stretched = true;
  }

  const last = ys.length - 1;
  const stops = ys.map((y, i) => ({
    y,
    dwellMs: Math.round(i === 0 ? INTRO_HOLD_MS : i === last ? dwell + OUTRO_EXTRA_MS : dwell),
  }));
  return { stops, estimatedMs: Math.round(total), stretched };
}

/* -------------------------------------------------------------------------- */
/* URL resolution                                                             */
/* -------------------------------------------------------------------------- */

interface LaunchConfig {
  configurations?: { name?: string; port?: number }[];
}

const LAUNCH_PATH = join(WEBSITES_ROOT, '.claude', 'launch.json');

export function portForSlug(config: LaunchConfig, slug: string): number | null {
  const hit = config.configurations?.find((c) => c.name === slug);
  return typeof hit?.port === 'number' ? hit.port : null;
}

/** Look a demo's dev-server port up in the shared launch.json. */
export function resolveDemoUrl(slug: string): { url: string; port: number } {
  if (!existsSync(LAUNCH_PATH)) {
    throw new Error(`No ${LAUNCH_PATH} - pass --url explicitly.`);
  }
  const port = portForSlug(JSON.parse(readFileSync(LAUNCH_PATH, 'utf8')) as LaunchConfig, slug);
  if (port === null) {
    throw new Error(
      `"${slug}" is not registered in ${LAUNCH_PATH}. ` +
      `Scaffold it with \`npm run new-demo -- --slug ${slug}\`, or pass --url.`,
    );
  }
  return { url: `http://localhost:${port}`, port };
}

/**
 * Confirm the dev server is up before spending a minute on a browser and two
 * ffmpeg passes. Starting the server here would mean owning its lifetime and
 * its failure modes, so this reports the command instead.
 */
export async function assertReachable(url: string, slug: string, port: number | null): Promise<void> {
  const hint =
    `Start it first, from ${WEBSITES_ROOT}:\n` +
    `    npm --prefix ${slug} run dev${port ? ` -- --port ${port}` : ''}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.status >= 500) {
      throw new Error(`${url} answered ${res.status}. The demo site is failing to render.\n${hint}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('answered')) throw err;
    throw new Error(`${url} is not responding (${(err as Error).message}).\n${hint}`);
  }
}

/* -------------------------------------------------------------------------- */
/* ffmpeg                                                                     */
/* -------------------------------------------------------------------------- */

/** `rgb(17, 17, 17)` / `rgba(...)` -> `0x111111` for ffmpeg's pad filter. */
export function cssColorToFfmpeg(css: string, fallback = '0x000000'): string {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(css.trim());
  if (!m) return fallback;
  const hex = [m[1], m[2], m[3]]
    .map((c) => clamp(Math.round(Number(c)), 0, 255).toString(16).padStart(2, '0'))
    .join('');
  return '0x' + hex;
}

export function ffmpegArgs(
  input: string,
  output: string,
  format: VideoFormat,
  opts: { trimSec?: number; padColor?: string } = {},
): string[] {
  const { width, height } = FORMATS[format].out;
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${opts.padColor ?? '0x000000'}`,
    'setsar=1',
    // Playwright's screencast is variable-rate; a fixed rate keeps players and
    // the DM upload pipelines from mis-timing the clip.
    'fps=30',
  ].join(',');

  const args = ['-y', '-i', input];
  // -ss AFTER -i decodes and discards, which is frame-accurate. Before -i it
  // snaps to a keyframe, and Playwright's WebM keyframes are far apart.
  if (opts.trimSec && opts.trimSec > 0.05) args.push('-ss', opts.trimSec.toFixed(3));
  args.push(
    '-vf', filter,
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level', '4.0',
    '-preset', 'medium',
    '-crf', '20',
    // Messenger, Instagram and QuickTime all reject anything but 4:2:0 here.
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an',
    output,
  );
  return args;
}

export interface VideoProbe {
  width: number;
  height: number;
  codec: string;
  pixFmt: string;
  durationMs: number;
  bytes: number;
}

export async function probeVideo(path: string): Promise<VideoProbe> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,pix_fmt:format=duration',
    '-of', 'json',
    path,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number; codec_name?: string; pix_fmt?: string }[];
    format?: { duration?: string };
  };
  const s = parsed.streams?.[0] ?? {};
  return {
    width: s.width ?? 0,
    height: s.height ?? 0,
    codec: s.codec_name ?? '',
    pixFmt: s.pix_fmt ?? '',
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
    bytes: statSync(path).size,
  };
}

async function assertFfmpeg(): Promise<void> {
  try {
    await execFileAsync('ffmpeg', ['-version']);
  } catch {
    throw new Error('ffmpeg is not on PATH. Install it, then re-run.');
  }
}

/* -------------------------------------------------------------------------- */
/* Page instrumentation (shared with mockup.ts)                               */
/* -------------------------------------------------------------------------- */

export interface RevealSample {
  /** Animated elements substantially inside the viewport. */
  inView: number;
  /** Of those, the ones still below the opacity threshold. */
  hidden: number;
  /** Largest un-settled vertical offset still on an animated element, in px. */
  maxTranslateY: number;
}

/**
 * Count scroll-reveal elements and how many have not landed yet.
 *
 * framer-motion writes its animated values as inline styles, so an inline
 * `opacity` is the marker for "this element's reveal is observable". Elements
 * only barely on screen are skipped: the hero fades out on scroll by design,
 * and counting its tail would report reveals that never fire.
 */
export async function sampleReveals(page: Page, minOpacity = 0.9): Promise<RevealSample> {
  return page.evaluate((threshold) => {
    const vh = window.innerHeight;
    let inView = 0;
    let hidden = 0;
    let maxTranslateY = 0;
    for (const el of Array.from(document.querySelectorAll('[style*="opacity"]'))) {
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      const visible = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (visible < Math.min(r.height * 0.6, 240)) continue;
      inView++;
      const cs = window.getComputedStyle(el);
      if (parseFloat(cs.opacity) < threshold) hidden++;
      const t = cs.transform;
      let ty = 0;
      if (t.startsWith('matrix3d(')) {
        const p = t.slice(9, -1).split(',');
        ty = Math.abs(Number(p[13] ?? 0));
      } else if (t.startsWith('matrix(')) {
        const p = t.slice(7, -1).split(',');
        ty = Math.abs(Number(p[5] ?? 0));
      }
      if (ty > maxTranslateY) maxTranslateY = ty;
    }
    return { inView, hidden, maxTranslateY };
  }, minOpacity);
}

/**
 * Wait out the splash screen.
 *
 * The template ships a loader that covers the viewport and locks body scroll
 * for about two seconds. Scrolling through it would record a walkthrough of a
 * grey rectangle, so this waits for any full-viewport fixed overlay to go and
 * for the scroll lock to lift. Returns false on timeout; the caller carries on
 * rather than aborting a recording over a heuristic.
 */
export async function waitForSplashToClear(page: Page, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const covered = await page.evaluate(() => {
      if (window.getComputedStyle(document.body).overflow === 'hidden') return true;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed' || parseFloat(cs.opacity) < 0.05) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= vw - 1 && r.height >= vh - 1) return true;
      }
      return false;
    });
    if (!covered) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

/** Poll until nothing on screen is mid-reveal. False means it never settled. */
export async function waitForRevealsToSettle(
  page: Page,
  opts: { timeoutMs?: number; minOpacity?: number; maxTranslateY?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  const maxTy = opts.maxTranslateY ?? 2;
  let stable = 0;
  while (Date.now() < deadline) {
    const s = await sampleReveals(page, opts.minOpacity ?? 0.99);
    // Two consecutive clean samples: one can catch the gap between a reveal
    // being triggered and its first animated frame being committed.
    if (s.hidden === 0 && s.maxTranslateY <= maxTy) {
      if (++stable >= 2) return true;
    } else {
      stable = 0;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

export interface SectionMeasure {
  /** Which selector the boundaries came from, for the run log. */
  source: string;
  tops: number[];
  pageHeight: number;
  viewportHeight: number;
}

/**
 * Find the page's top-level section boundaries.
 *
 * `section` alone is wrong for these sites: AnimatedSection nests, so the four
 * cards inside a feature strip are each a `<section>` and would each become a
 * stop. Direct children of `main` are the real boundaries, and the hero is one
 * of them despite being a `div`.
 */
export async function measureSections(page: Page): Promise<SectionMeasure> {
  return page.evaluate(() => {
    const visible = (selector: string): PageEl[] =>
      Array.from(document.querySelectorAll(selector)).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 80 && r.width > 0;
      });

    let source = 'none';
    let chosen: PageEl[] = [];
    for (const selector of ['[data-section]', 'main > *', 'main section', 'body > *']) {
      const els = visible(selector);
      if (els.length >= 2) { source = selector; chosen = els; break; }
    }

    const footer = document.querySelector('footer');
    if (footer && !chosen.includes(footer)) chosen.push(footer);

    const scrollY = window.scrollY;
    const tops = chosen.map((el) => Math.max(0, Math.round(el.getBoundingClientRect().top + scrollY)));
    return {
      source,
      tops: Array.from(new Set(tops)).sort((a, b) => a - b),
      pageHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  });
}

export interface ElementBox { selector: string; x: number; y: number; width: number; height: number }

/** First visible element matching any selector, in document space. */
export async function measureBox(
  page: Page,
  selectors: readonly string[],
  minHeightRatio = 0,
): Promise<ElementBox | null> {
  return page.evaluate(
    ({ list, ratio }) => {
      for (const selector of list) {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height < window.innerHeight * ratio) continue;
          return {
            selector,
            x: Math.max(0, Math.round(r.left)),
            y: Math.max(0, Math.round(r.top + window.scrollY)),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        }
      }
      return null;
    },
    { list: [...selectors], ratio: minHeightRatio },
  );
}

export async function pageBackgroundColor(page: Page): Promise<string> {
  return page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
}

/** Rendered text length, used as a "did anything actually paint" guard. */
export async function visibleTextLength(page: Page): Promise<number> {
  return page.evaluate(() => document.body.innerText.trim().length);
}

/** Wait until the page stops scrolling, whatever duration the browser chose. */
async function settleScroll(page: Page, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = Number.NaN;
  let stable = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const y = await page.evaluate(() => window.scrollY);
    if (Math.abs(y - last) < 1) {
      if (++stable >= 2) return y;
    } else {
      stable = 0;
    }
    last = y;
  }
  return last;
}

/* -------------------------------------------------------------------------- */
/* Recording                                                                  */
/* -------------------------------------------------------------------------- */

export interface Take {
  format: VideoFormat;
  path: string;
  probe: VideoProbe;
  /** Selector the section boundaries came from. */
  sectionSource: string;
  stops: number;
  /** Reveals observed going from hidden to shown while recording. */
  revealsFired: number;
  /** Reveals still hidden after their dwell - these did not fire on camera. */
  revealsStuck: number;
  plannedMs: number;
  splashCleared: boolean;
}

export interface RecordOptions {
  slug: string;
  url?: string;
  only?: VideoFormat;
  targetMs?: number;
  /** Lower the 20 s runtime floor, for short smoke-test takes. */
  minTotalMs?: number;
  outDir?: string;
  headed?: boolean;
  log?: (msg: string) => void;
}

export interface RecordReport {
  slug: string;
  url: string;
  outDir: string;
  takes: Take[];
}

async function recordTake(
  browser: Browser,
  url: string,
  format: VideoFormat,
  outPath: string,
  pacing: { targetMs?: number; minTotalMs?: number },
  log: (msg: string) => void,
): Promise<Take> {
  const spec = FORMATS[format];
  const tmpDir = join(outPath, '..', `.video-tmp-${format}`);
  mkdirSync(tmpDir, { recursive: true });

  const ctx = await browser.newContext({
    viewport: spec.viewport,
    deviceScaleFactor: spec.deviceScaleFactor,
    isMobile: spec.isMobile,
    hasTouch: spec.isMobile,
    locale: 'en-PH',
    timezoneId: 'Asia/Manila',
    // The reveals ARE the product being sold here; a reduced-motion default
    // inherited from the host would flatten the whole video.
    reducedMotion: 'no-preference',
    recordVideo: {
      dir: tmpDir,
      size: {
        width: spec.viewport.width * spec.deviceScaleFactor,
        height: spec.viewport.height * spec.deviceScaleFactor,
      },
    },
  });

  // Recording starts with the context, so the clock starts here too.
  const startedAt = Date.now();
  const page = await ctx.newPage();

  // tsx compiles with esbuild's keepNames, which wraps functions in a `__name`
  // helper. Playwright serializes evaluate() callbacks as source text, so that
  // helper travels to the page where it does not exist and every evaluate call
  // dies with "__name is not defined". Define it as a no-op before page
  // scripts run.
  await page.addInitScript(() => {
    (globalThis as unknown as { __name?: unknown }).__name ??= <T,>(fn: T): T => fn;
  });
  const video = page.video();

  let plan: WalkPlan = { stops: [], estimatedMs: 0, stretched: false };
  let sectionSource = 'none';
  let splashCleared = false;
  let revealsFired = 0;
  let revealsStuck = 0;
  let trimSec = 0;
  let padColor = '0x000000';

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // Next.js dev injects hidden overlay containers as the first children of
    // <body>, so a bare `body > *` resolves to a permanently-hidden <div hidden>
    // and the visibility wait never satisfies. Wait for real content instead.
    await page.waitForSelector('main:not([hidden]), body > *:not([hidden]):not(script):not(style)', {
      state: 'visible',
      timeout: 20_000,
    });
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(200);

    // Everything before first paint is black frames. Trim them, but keep a
    // quarter-second of lead-in so the splash does not start mid-fade.
    trimSec = Math.max(0, (Date.now() - startedAt - 250) / 1000);

    splashCleared = await waitForSplashToClear(page);
    if (!splashCleared) log(`${format}: splash overlay never cleared - recording anyway`);

    padColor = cssColorToFfmpeg(await pageBackgroundColor(page));

    const measured = await measureSections(page);
    sectionSource = measured.source;
    plan = planWalkthrough(measured.tops, measured, pacing);
    log(
      `${format}: ${measured.tops.length} sections via "${measured.source}", ` +
      `${plan.stops.length} stops, ~${(plan.estimatedMs / 1000).toFixed(1)}s planned` +
      (plan.stretched ? ' (short page - dwell stretched)' : ''),
    );

    for (const [i, stop] of plan.stops.entries()) {
      if (i > 0) {
        await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), stop.y);
        await settleScroll(page);
      }
      // Sampling on arrival and again after the pause is what proves the
      // reveals fired while the camera was rolling, rather than before it.
      const arrival = await sampleReveals(page);
      await page.waitForTimeout(stop.dwellMs);
      const after = await sampleReveals(page);
      revealsFired += Math.max(0, arrival.hidden - after.hidden);
      revealsStuck += after.hidden;
    }
  } finally {
    await ctx.close();
  }

  const webm = await video?.path();
  if (!webm) throw new Error(`Playwright produced no video for the ${format} take.`);

  await execFileAsync('ffmpeg', ffmpegArgs(webm, outPath, format, { trimSec, padColor }), {
    maxBuffer: 32 * 1024 * 1024,
  });
  rmSync(tmpDir, { recursive: true, force: true });

  return {
    format,
    path: outPath,
    probe: await probeVideo(outPath),
    sectionSource,
    stops: plan.stops.length,
    revealsFired,
    revealsStuck,
    plannedMs: plan.estimatedMs,
    splashCleared,
  };
}

/** Record the walkthrough in every requested format. */
export async function recordDemo(opts: RecordOptions): Promise<RecordReport> {
  const log = opts.log ?? (() => {});
  await assertFfmpeg();

  let port: number | null = null;
  let url = opts.url;
  if (!url) {
    const resolved = resolveDemoUrl(opts.slug);
    url = resolved.url;
    port = resolved.port;
  }
  await assertReachable(url, opts.slug, port);

  const outDir = opts.outDir ?? join(WEBSITES_ROOT, opts.slug, 'demo');
  mkdirSync(outDir, { recursive: true });

  const formats = opts.only ? [opts.only] : [...VIDEO_FORMATS];
  const browser = await launch(!opts.headed);
  const takes: Take[] = [];
  try {
    for (const format of formats) {
      takes.push(
        await recordTake(
          browser,
          url,
          format,
          join(outDir, `${opts.slug}-${format}.mp4`),
          { targetMs: opts.targetMs, minTotalMs: opts.minTotalMs },
          log,
        ),
      );
    }
  } finally {
    await browser.close();
  }

  return { slug: opts.slug, url, outDir, takes };
}
