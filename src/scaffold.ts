/**
 * Scaffold a demo site from the template.
 *
 * Shared by `npm run new-demo` and the campaign orchestrator so there is one
 * implementation of port allocation and content seeding.
 */
import {
  cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './config.ts';
import type { Lead } from './lead.ts';

export const WEBSITES_ROOT = resolve(ROOT, '..');
const TEMPLATE = join(ROOT, 'templates', 'demo-site');
const LAUNCH = join(WEBSITES_ROOT, '.claude', 'launch.json');
const LAUNCH_LOCK = `${LAUNCH}.lock`;

/** Ports below this are taken by existing projects, the console (3008),
 *  the portfolio (3009) and fb-lead-capture (3010). */
const FIRST_DEMO_PORT = 3011;

/** How long a session will wait for another session's port allocation
 *  before giving up - allocation itself is a handful of sync file ops, so
 *  a real holder finishes in milliseconds; this is a crash-guard budget. */
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;

interface LaunchConfig {
  version: string;
  configurations: { name: string; runtimeExecutable: string; runtimeArgs: string[]; port: number }[];
}

/** Synchronous sleep, without busy-spinning a CPU core. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive lock on launch.json.
 *
 * The read-modify-write of launch.json is not otherwise atomic: two
 * concurrent Claude Code sessions can both read the same "taken" port set
 * before either writes, allocate the same port, and then the later write
 * clobbers the earlier session's new entry outright (last-write-wins on
 * the whole file, not a merge). An exclusive-create lock file closes that
 * window - only the session that WRITES the lock file first proceeds.
 */
export function withLaunchLock<T>(
  fn: () => T,
  opts: { lockPath?: string; timeoutMs?: number; retryMs?: number } = {},
): T {
  const lockPath = opts.lockPath ?? LAUNCH_LOCK;
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? LOCK_RETRY_MS;
  const start = Date.now();
  for (;;) {
    try {
      // 'wx' fails with EEXIST if the file already exists - that failure
      // IS the mutex.
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for ${lockPath} - if a previous session crashed while ` +
          'holding it, delete the lock file and retry.',
        );
      }
      sleepSync(retryMs);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/** Parse and shape-check a launch.json. Throws before any scaffold file is
 *  touched rather than after, so a bad launch.json never leaves a half-
 *  copied demo directory blocking a retry with "already exists". */
export function readLaunchConfig(path: string = LAUNCH): LaunchConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const cfg = parsed as Partial<LaunchConfig> | null;
  if (!cfg || !Array.isArray(cfg.configurations)) {
    throw new Error(`${path} is missing a "configurations" array`);
  }
  return { version: cfg.version ?? '0.0.1', configurations: cfg.configurations };
}

/**
 * Pure port allocation: given the current configurations array, return the
 * port for `slug` and the configurations array as it should be written
 * back. Kept side-effect-free and separate from the file I/O in
 * `withLaunchLock` above so the allocation logic itself - the part the
 * race condition was actually in - can be unit tested directly.
 */
export function allocatePort(
  configurations: LaunchConfig['configurations'],
  slug: string,
): { port: number; configurations: LaunchConfig['configurations']; isNew: boolean } {
  const existing = configurations.find((c) => c.name === slug);
  if (existing) return { port: existing.port, configurations, isNew: false };

  // Ports may have been stored as strings by hand-edits - coerce so a
  // "3011" entry still blocks reallocating 3011.
  const taken = new Set(
    configurations.map((c) => Number(c.port)).filter((p) => Number.isInteger(p)),
  );
  let port = FIRST_DEMO_PORT;
  while (taken.has(port)) port++;
  const next = [
    ...configurations,
    {
      name: slug,
      runtimeExecutable: 'npm',
      runtimeArgs: ['--prefix', slug, 'run', 'dev', '--', '--port', String(port)],
      port,
    },
  ];
  return { port, configurations: next, isNew: true };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'demo';
}

function replaceInTree(dir: string, pairs: [string, string][]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { replaceInTree(p, pairs); continue; }
    if (!/\.(ts|tsx|json|md|css|mjs)$/.test(entry)) continue;
    const s = readFileSync(p, 'utf8');
    let out = s;
    for (const [a, b] of pairs) out = out.split(a).join(b);
    if (out !== s) writeFileSync(p, out);
  }
}

export interface ScaffoldResult { slug: string; path: string; port: number }

export function scaffoldDemo(opts: {
  slug: string;
  lead?: Lead;
  force?: boolean;
}): ScaffoldResult {
  const { slug, lead } = opts;
  const target = join(WEBSITES_ROOT, slug);
  if (existsSync(target) && !opts.force) {
    throw new Error(`${target} already exists (use --force)`);
  }
  // Fail on a malformed/missing launch.json BEFORE cpSync below copies
  // anything - a missing "configurations" array or bad JSON here used to
  // surface only after the template was already in place.
  readLaunchConfig();

  cpSync(TEMPLATE, target, { recursive: true });
  for (const d of ['research/images', 'research/notes', 'public/images']) {
    mkdirSync(join(target, d), { recursive: true });
  }

  const displayName =
    lead?.name ?? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const contentPath = join(target, 'src/data/content.json');
  const content = JSON.parse(readFileSync(contentPath, 'utf8'));
  content.brand.name = displayName;
  content.brand.category = lead?.category ?? '';
  content.brand.email = lead?.email ?? '';
  content.brand.social.instagram = lead?.instagram ?? '';
  content.brand.social.facebook = lead?.facebook ?? '';
  content.brand.social.tiktok = lead?.tiktok ?? '';
  content.branches[0].name = displayName;
  content.branches[0].phone = lead?.phone ?? '';
  content.branches[0].phoneDisplay = lead?.phone ?? '';
  content.branches[0].mapQuery = displayName;
  // Seeded values are unconfirmed until checked against the client's own
  // channels. They stay listed on the page until each one is verified.
  content.openItemsToConfirm = [
    'Confirm the business name, address and opening hours with the owner.',
    'Confirm menu items and prices.',
    lead?.phone
      ? 'Confirm this phone number is the one they want published.'
      : 'No phone number sourced yet.',
    'Confirm which photos may be used, and their attribution.',
  ];
  writeFileSync(contentPath, JSON.stringify(content, null, 2) + '\n');

  replaceInTree(target, [['__SLUG__', slug], ['__BUSINESS_NAME__', displayName]]);

  // Read launch.json as late as possible, and under the lock: concurrent
  // Claude Code sessions edit this file, and reading it outside the lock
  // (the previous behaviour) let two sessions both see the same "taken"
  // port set, allocate the same port, and have the second write silently
  // drop the first session's new entry.
  const port = withLaunchLock(() => {
    const launch = readLaunchConfig();
    const result = allocatePort(launch.configurations, slug);
    if (result.isNew) {
      writeFileSync(
        LAUNCH,
        JSON.stringify({ ...launch, configurations: result.configurations }, null, 2) + '\n',
      );
    }
    return result.port;
  });

  return { slug, path: target, port };
}
