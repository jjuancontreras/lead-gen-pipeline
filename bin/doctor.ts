#!/usr/bin/env tsx
/**
 * Setup check: what is configured, what is missing, what that costs you.
 *
 *   npm run doctor
 *
 * Exists because every credential in this system degrades silently by
 * design — a missing Gemini key skips photo curation, a missing Sheet
 * falls back to local JSON, a missing Gmail token writes files instead of
 * drafts. That is the right behaviour for a pipeline you run unattended,
 * but it means "nothing errored" tells you nothing about what is actually
 * switched on.
 */
import '../src/env.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CREDENTIALS } from '../src/env.ts';
import { gmailCredsUsable } from '../src/gmail-creds.ts';
import { ROOT, configPath, dataPath, loadAreas, loadChainIndex } from '../src/config.ts';
import { openStore } from '../src/store.ts';
import { settings } from '../src/settings.ts';

const ok = (s: string) => `  [ok]      ${s}`;
const warn = (s: string) => `  [missing] ${s}`;
const bad = (s: string) => `  [BROKEN]  ${s}`;

console.log('\nPipeline doctor\n');

// ---- tools ----------------------------------------------------------
console.log('Tools');
const TOOL_CHECKS: { cmd: string; args: string[]; label: string }[] = [
  { cmd: 'node', args: ['--version'], label: 'node' },
  { cmd: 'python', args: ['--version'], label: 'python (palette sampler)' },
  { cmd: 'ffmpeg', args: ['-version'], label: 'ffmpeg (video recorder)' },
];
for (const { cmd, args, label } of TOOL_CHECKS) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    console.log(ok(`${label}: ${out.split('\n')[0]!.trim().slice(0, 40)}`));
  } catch {
    console.log(bad(`${label}: not found on PATH`));
  }
}
try {
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ headless: true });
  await b.close();
  console.log(ok('playwright chromium: launches'));
} catch (err) {
  console.log(bad(`playwright chromium: ${(err as Error).message.split('\n')[0]}`));
}
try {
  const sharp = (await import('sharp')).default;
  console.log(ok(`sharp: ${sharp.versions.sharp}`));
} catch {
  console.log(bad('sharp: not loadable - run npm install'));
}

// ---- credentials ----------------------------------------------------
console.log('\nCredentials  (.env.local)');
const envFile = `${ROOT}\\.env.local`;
console.log(existsSync(envFile) ? ok('.env.local found') : warn('.env.local not found - copy .env.example'));
for (const c of CREDENTIALS) {
  const v = process.env[c.key];
  if (c.key === 'GMAIL_TOKEN_PATH' && v) {
    console.log(
      gmailCredsUsable(v)
        ? ok('GMAIL_TOKEN_PATH set')
        : warn('GMAIL_TOKEN_PATH set but unusable (missing refresh_token) - outreach will write files to data/drafts/'),
    );
    continue;
  }
  console.log(v ? ok(`${c.key} set`) : warn(`${c.key} - ${c.unlocks}`));
}
if (process.env.GOOGLE_SA_KEY_PATH && !existsSync(process.env.GOOGLE_SA_KEY_PATH)) {
  console.log(bad(`GOOGLE_SA_KEY_PATH points at a file that does not exist`));
}

// ---- data -----------------------------------------------------------
console.log('\nData');
const index = loadChainIndex();
if (index) {
  const age = Math.floor((Date.now() - Date.parse(index.generatedAt)) / 86_400_000);
  const stale = age > 90;
  console.log((stale ? warn : ok)(
    `chain index: ${Object.keys(index.counts).length} names, ${index.totalPois} POIs, ${age} days old` +
    (stale ? ' - rebuild with: npm run chain-index' : ''),
  ));
} else {
  console.log(bad('chain index missing - run: npm run chain-index'));
}

const areas = Object.keys(loadAreas().areas);
console.log(areas.length ? ok(`areas: ${areas.join(', ')}`) : warn('no areas defined - draw one in the console'));

const store = openStore();
const leads = await store.all();
const byStatus: Record<string, number> = {};
for (const l of leads) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
console.log(ok(`store: ${store.kind} - ${leads.length} leads`));
if (leads.length) {
  console.log(`            ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
if (store.kind === 'json') {
  console.log(`            (set GOOGLE_SHEET_ID + GOOGLE_SA_KEY_PATH to switch to Sheets)`);
}

// ---- what runs ------------------------------------------------------
console.log('\nWhat will run in a campaign right now');
const gmailOk = process.env.GMAIL_TOKEN_PATH && gmailCredsUsable(process.env.GMAIL_TOKEN_PATH);
const lines = [
  ['source', true, 'always'],
  ['verify', true, 'always'],
  ['enrich', true, 'always (Gemini only improves it)'],
  ['outreach', true, gmailOk ? 'creates Gmail drafts' : 'writes files to data/drafts (no Gmail token)'],
] as const;
for (const [name, on, note] of lines) {
  console.log(`  ${on ? '[on] ' : '[off]'} ${name.padEnd(9)} ${note}`);
}
console.log(`  ${process.env.GEMINI_API_KEY ? '[on] ' : '[off]'} harvest   ` +
  (process.env.GEMINI_API_KEY
    ? 'photo curation + menu OCR enabled'
    : 'photos still download; curation and menu OCR skipped'));

// ---- demo pipeline --------------------------------------------------
console.log('\nDemo pipeline  (npm run pipeline, console /pipeline)');
const s = settings();
console.log(ok('sending: OFF - SEND_EMAILS is false and no transport exists; emails are drafts'));
console.log(s.senderEmail
  ? ok(`sender: ${s.senderName ?? 'default name'} <${s.senderEmail}>`)
  : warn('SENDER_EMAIL not set - every email stage will fail until it is'));
console.log(/\/\/(localhost|127\.)/.test(s.publicBaseUrl)
  ? warn(`PUBLIC_BASE_URL is ${s.publicBaseUrl} - links in drafts only open on this machine`)
  : ok(`links in drafts point at ${s.publicBaseUrl}`));
console.log(s.portfolioUrls.length
  ? ok(`portfolio: ${s.portfolioUrls.length} link(s) in first-contact emails`)
  : warn('PORTFOLIO_URLS not set - first-contact emails go out without links to your past demos'));
console.log(existsSync(join(s.demoSitesRoot, '.claude', 'launch.json'))
  ? ok(`Next.js demos (scaffold/record/harvest): ${s.demoSitesRoot}`)
  : warn(`no .claude/launch.json under ${s.demoSitesRoot} - set DEMO_SITES_ROOT to where the demo folders live`));

console.log(`\n  data dir: ${dataPath('')}`);
console.log(`  config:   ${configPath('')}\n`);
