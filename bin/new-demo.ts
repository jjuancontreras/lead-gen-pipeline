#!/usr/bin/env tsx
/**
 * Scaffold a demo site from the template.
 *
 *   npm run new-demo -- --slug kuro-cafe [--lead node/123456]
 *
 * Copies the template, seeds content.json from the lead row, and registers a
 * dev-server port. The template ships a deliberately neutral grey palette:
 * if a demo still looks like that, the visual system has not been derived yet.
 */
import {
  cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from '../src/config.ts';
import { openStore } from '../src/store.ts';
import type { Lead } from '../src/lead.ts';

const args = process.argv.slice(2);
const val = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const slug = val('--slug');
const leadId = val('--lead');
const force = args.includes('--force');

if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error('\nUsage: npm run new-demo -- --slug <kebab-case-name> [--lead node/123]');
  process.exit(1);
}

const WEBSITES = resolve(ROOT, '..');            // ...\Desktop\Websites
const target = join(WEBSITES, slug);
const template = join(ROOT, 'templates', 'demo-site');
const launchPath = join(WEBSITES, '.claude', 'launch.json');

if (existsSync(target) && !force) {
  console.error(`\n${target} already exists. Use --force to overwrite scaffolding.\n`);
  process.exit(1);
}

// ---- port allocation -------------------------------------------------------
// 3008 is the pipeline console and 3009 the portfolio, so demos start at 3011
// (3010 is fb-lead-capture). Read launch.json immediately before writing:
// concurrent Claude Code sessions edit this file.
interface LaunchConfig {
  version: string;
  configurations: { name: string; runtimeExecutable: string; runtimeArgs: string[]; port: number }[];
}
const launch = JSON.parse(readFileSync(launchPath, 'utf8')) as LaunchConfig;
const used = new Set(launch.configurations.map((c) => c.port));
let port = 3011;
while (used.has(port)) port++;

// ---- copy the template -----------------------------------------------------
cpSync(template, target, { recursive: true });
for (const d of ['research/images', 'research/notes', 'public/images']) {
  mkdirSync(join(target, d), { recursive: true });
}

// ---- seed from the lead ----------------------------------------------------
let lead: Lead | undefined;
if (leadId) {
  lead = (await openStore().all()).find((l) => l.lead_id === leadId);
  if (!lead) console.warn(`  ! lead ${leadId} not found - seeding placeholders only`);
}
const displayName = lead?.name ?? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const contentPath = join(target, 'src/data/content.json');
const content = JSON.parse(readFileSync(contentPath, 'utf8'));
content.brand.name = displayName;
content.brand.category = lead?.category ?? '';
content.brand.email = lead?.email ?? '';
content.brand.socials = {
  instagram: lead?.instagram ?? '',
  facebook: lead?.facebook ?? '',
  tiktok: lead?.tiktok ?? '',
};
content.branches[0].name = displayName;
content.branches[0].phone = lead?.phone ?? '';
content.branches[0].phoneDisplay = lead?.phone ?? '';
content.branches[0].mapQuery = displayName;
// Seeded fields are unconfirmed until checked against the client's own
// channels; they stay listed on the page until each one is verified.
content.openItemsToConfirm = [
  'Confirm the business name, address and opening hours with the owner.',
  'Confirm menu items and prices.',
  lead?.phone ? 'Confirm the phone number is the one they want published.' : 'No phone number sourced yet.',
  'Confirm which photos may be used, and their attribution.',
];
writeFileSync(contentPath, JSON.stringify(content, null, 2) + '\n');

// ---- fill template placeholders --------------------------------------------
function replaceInTree(dir: string, pairs: [string, string][]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { replaceInTree(p, pairs); continue; }
    if (!/\.(ts|tsx|json|md|css|mjs)$/.test(entry)) continue;
    let s = readFileSync(p, 'utf8');
    const before = s;
    for (const [a, b] of pairs) s = s.split(a).join(b);
    if (s !== before) writeFileSync(p, s);
  }
}
replaceInTree(target, [['__SLUG__', slug], ['__BUSINESS_NAME__', displayName]]);

// ---- register the dev-server port ------------------------------------------
// Re-read here rather than reusing the copy above: another session may have
// added an entry while we were copying files.
const fresh = JSON.parse(readFileSync(launchPath, 'utf8')) as LaunchConfig;
if (fresh.configurations.some((c) => c.name === slug)) {
  console.log(`  launch.json already has "${slug}" - left untouched`);
} else {
  const taken = new Set(fresh.configurations.map((c) => c.port));
  while (taken.has(port)) port++;
  fresh.configurations.push({
    name: slug,
    runtimeExecutable: 'npm',
    runtimeArgs: ['--prefix', slug, 'run', 'dev', '--', '--port', String(port)],
    port,
  });
  writeFileSync(launchPath, JSON.stringify(fresh, null, 2) + '\n');
}

if (lead && !args.includes('--no-store-update')) {
  await openStore().update(lead.lead_id, { demo_slug: slug, status: 'demo_built' });
}

console.log(`\n  scaffolded ${displayName}`);
console.log(`    path:  ${target}`);
console.log(`    port:  ${port}  (registered in .claude/launch.json)`);
if (lead) console.log(`    lead:  ${lead.lead_id}  tier ${lead.tier || '-'}`);
console.log(`\n  next:`);
console.log(`    cd ${slug} && npm install`);
console.log(`    derive the visual system into DESIGN.md, then fill globals.css`);
console.log(`    the template palette is neutral grey on purpose - replace it\n`);
