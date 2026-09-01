/**
 * Scaffold a demo site from the template.
 *
 * Shared by `npm run new-demo` and the campaign orchestrator so there is one
 * implementation of port allocation and content seeding.
 */
import {
  cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './config.ts';
import type { Lead } from './lead.ts';

export const WEBSITES_ROOT = resolve(ROOT, '..');
const TEMPLATE = join(ROOT, 'templates', 'demo-site');
const LAUNCH = join(WEBSITES_ROOT, '.claude', 'launch.json');

/** Ports below this are taken by existing projects, the console (3008),
 *  the portfolio (3009) and fb-lead-capture (3010). */
const FIRST_DEMO_PORT = 3011;

interface LaunchConfig {
  version: string;
  configurations: { name: string; runtimeExecutable: string; runtimeArgs: string[]; port: number }[];
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

  // Read launch.json as late as possible: concurrent Claude Code sessions
  // edit this file, and a stale copy would clobber another session's entry.
  const launch = JSON.parse(readFileSync(LAUNCH, 'utf8')) as LaunchConfig;
  let port = FIRST_DEMO_PORT;
  if (launch.configurations.some((c) => c.name === slug)) {
    port = launch.configurations.find((c) => c.name === slug)!.port;
  } else {
    const taken = new Set(launch.configurations.map((c) => c.port));
    while (taken.has(port)) port++;
    launch.configurations.push({
      name: slug,
      runtimeExecutable: 'npm',
      runtimeArgs: ['--prefix', slug, 'run', 'dev', '--', '--port', String(port)],
      port,
    });
    writeFileSync(LAUNCH, JSON.stringify(launch, null, 2) + '\n');
  }

  return { slug, path: target, port };
}
