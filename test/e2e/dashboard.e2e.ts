/**
 * Playwright checks for the demo-pipeline dashboard.
 *
 *   npm run test:ui
 *
 * Seeds a throwaway data directory with three leads (two fully done, one
 * whose email stage failed), starts the real console against it on a free
 * port, and drives the page in headless Chromium: loading, empty and error
 * states, per-stage retry, the site/video/email previews, form validation,
 * keyboard use, phone width, and an axe accessibility scan. Every page must
 * finish with zero console errors. Screenshots go to docs/screenshots/.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page, type ConsoleMessage } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { JsonStore } from '../../src/store.ts';
import { createLogger } from '../../src/log.ts';
import { PipelineState } from '../../src/pipeline/state.ts';
import { runPipeline } from '../../src/pipeline/runner.ts';
import { findStage } from '../../src/pipeline/stages/find.ts';
import { siteStage } from '../../src/pipeline/stages/site.ts';
import { emailStage } from '../../src/pipeline/stages/email.ts';
import { loadFixtureLeads } from '../../src/pipeline/leads.ts';
import { NO_TRANSPORT } from '../../src/pipeline/mailer.ts';
import type { PipelineStage } from '../../src/pipeline/stage.ts';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SHOTS = join(ROOT, 'docs', 'screenshots');

/** A real, tiny H.264 clip, so the video preview plays without a 30 s recording. */
const quickVideo: PipelineStage<'video'> = {
  name: 'video',
  description: 'ffmpeg test pattern',
  async run({ site }, ctx) {
    const dir = join(ctx.dataDir, 'videos', site!.slug);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${site!.slug}-16x9.mp4`);
    await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=15',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', path]);
    return {
      path, url: `${ctx.publicBaseUrl}/videos/${site!.slug}/${site!.slug}-16x9.mp4`,
      durationMs: 2000, bytes: statSync(path).size, width: 320, height: 180,
    };
  },
  isIntact: () => true,
};

async function seed(dataDir: string): Promise<void> {
  const store = new JsonStore(join(dataDir, 'leads.json'));
  const leads = loadFixtureLeads(join(ROOT, 'test', 'fixtures', 'businesses.json'))
    // Lola Nena's has no email yet, so its email stage fails - the retry case.
    .map((l) => (l.lead_id === 'fixture/2' ? { ...l, email: '' } : l));
  await store.upsert(leads);
  await runPipeline({
    leads, store,
    state: new PipelineState(join(dataDir, 'pipeline-state.json')),
    stages: [findStage, siteStage, quickVideo, emailStage],
    ctx: {
      dataDir, publicBaseUrl: 'http://localhost:3008', videoMs: 5000, sendEmails: false,
      mailer: NO_TRANSPORT, senderName: 'Jfer Contreras', senderEmail: 'sender@example.com',
      areaLabel: () => 'Katipunan, Quezon City',
      log: createLogger({ format: 'json', level: 'error', sink: () => {} }),
    },
  });
}

interface Console { url: string; child: ChildProcess }

async function startConsole(dataDir: string): Promise<Console> {
  const child = spawn(process.execPath, [TSX, 'bin/console.ts'], {
    cwd: ROOT,
    env: {
      ...process.env, PIPELINE_DATA_DIR: dataDir, PIPELINE_STORE: 'json', CONSOLE_PORT: '0',
      SENDER_EMAIL: 'sender@example.com', SEND_EMAILS: 'false', LOG_LEVEL: 'warn',
    },
  });
  const url = await new Promise<string>((ok, fail) => {
    let out = '';
    const timer = setTimeout(() => fail(new Error(`console did not start:\n${out}`)), 30_000);
    child.stdout!.on('data', (b: Buffer) => {
      out += b;
      const m = /pipeline console -> (http:\/\/localhost:\d+)/.exec(out);
      if (m) { clearTimeout(timer); ok(m[1]!); }
    });
    child.stderr!.on('data', (b: Buffer) => { out += b; });
  });
  return { url, child };
}

let browser: Browser;
let seeded: Console;
let empty: Console;
const dirs: string[] = [];
const consoleErrors: string[] = [];

/** A page that records every console error and uncaught exception. */
async function open(path: string, base: Console = seeded, viewport = { width: 1280, height: 900 }): Promise<Page> {
  // A page from its own context: axe needs one, and it isolates each check.
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') consoleErrors.push(`${path}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${path}: ${e.message}`));
  await page.goto(base.url + path);
  return page;
}

const row = (page: Page, name: string) => page.locator('tbody tr', { hasText: name });

before(async () => {
  const seededDir = mkdtempSync(join(tmpdir(), 'dash-seeded-'));
  const emptyDir = mkdtempSync(join(tmpdir(), 'dash-empty-'));
  dirs.push(seededDir, emptyDir);
  await seed(seededDir);
  [seeded, empty] = await Promise.all([startConsole(seededDir), startConsole(emptyDir)]);
  browser = await chromium.launch();
  mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  await browser?.close();
  seeded?.child.kill();
  empty?.child.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('shows every lead with its status in each of the four stages', async () => {
  const page = await open('/pipeline');
  await page.locator('tbody tr').first().waitFor();
  assert.equal(await page.locator('tbody tr').count(), 3);
  for (const name of ['Kapihan sa Kanto', 'Café Ñora & Sons Bakery']) {
    const cells = row(page, name).locator('.pill');
    assert.deepEqual(await cells.allTextContents(), ['✓Done', '✓Done', '✓Done', '✓Done'], name);
  }
  const lola = await row(page, "Lola Nena's Kusina").locator('.pill').allTextContents();
  assert.deepEqual(lola, ['✓Done', '✓Done', '✓Done', '!Failed']);
  assert.match(await row(page, "Lola Nena's Kusina").innerText(), /no email address on record/);
  assert.match(await page.locator('#cards').innerText(), /EMAIL\s+2\s*of 3 done\s+1 failed/i);
  assert.match(await page.locator('#sending').innerText(), /Sending off/);
  await page.screenshot({ path: join(SHOTS, 'dashboard-desktop.png'), fullPage: true });
  await page.close();
});

test('loading state: a skeleton marked busy while the data is on its way', async () => {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`loading: ${m.text()}`); });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/pipeline', async (route) => { await gate; await route.continue(); });
  await page.goto(`${seeded.url}/pipeline`);
  await page.locator('#boardbody .skel').first().waitFor();
  assert.equal(await page.locator('#boardbody').getAttribute('aria-busy'), 'true');
  release();
  await page.locator('tbody tr').first().waitFor();
  assert.equal(await page.locator('#boardbody').getAttribute('aria-busy'), 'false');
  await page.close();
});

test('empty state: says what to do when nothing has run yet', async () => {
  const page = await open('/pipeline', empty);
  await page.getByText('No leads have been through the demo pipeline yet').waitFor();
  assert.match(await page.locator('#boardbody').innerText(), /npm run pipeline -- --fixtures/);
  await page.screenshot({ path: join(SHOTS, 'dashboard-empty.png') });
  await page.close();
});

test('error state: a failed load explains itself and recovers on "Try again"', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  let fail = true;
  await page.route('**/api/pipeline', (route) => (fail
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk on fire' }) })
    : route.continue()));
  await page.goto(`${seeded.url}/pipeline`);
  await page.getByRole('alert').filter({ hasText: 'Could not load the pipeline' }).waitFor();
  assert.match(await page.locator('#boardbody').innerText(), /disk on fire/);
  await page.screenshot({ path: join(SHOTS, 'dashboard-error.png') });
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.locator('tbody tr').first().waitFor();
  // The only console error allowed is the browser's own note about the 500 we forced.
  assert.ok(errors.every((e) => /status of 500/.test(e)), errors.join('\n'));
  await page.close();
});

test('previews show the generated site, the video and the email draft; Escape closes', async () => {
  const page = await open('/pipeline');
  const button = page.getByRole('button', { name: 'Preview site, video and email for Kapihan sa Kanto' });
  await button.click();
  const dialog = page.getByRole('dialog', { name: /Preview - Kapihan sa Kanto/ });
  await dialog.waitFor();
  // Let the sheet finish sliding in before judging or photographing it.
  await page.waitForFunction(() => {
    const r = document.getElementById('preview')!.getBoundingClientRect();
    return Math.abs(r.right - window.innerWidth) < 1 && r.left >= 0;
  });
  assert.equal(await dialog.getByRole('button', { name: 'Close preview' }).evaluate((b) => b === document.activeElement), true);

  const site = page.frameLocator('#preview iframe');
  assert.equal((await site.locator('h1').textContent())?.trim(), 'Kapihan sa Kanto');
  await page.screenshot({ path: join(SHOTS, 'dashboard-preview-site.png') });

  // Arrow keys move between tabs.
  await dialog.getByRole('tab', { name: 'Site' }).focus();
  await page.keyboard.press('ArrowRight');
  const video = dialog.locator('video');
  await video.waitFor();
  const ready = await video.evaluate((v: HTMLVideoElement) => new Promise<number>((ok) => {
    if (v.readyState >= 1) ok(v.duration);
    else v.addEventListener('loadedmetadata', () => ok(v.duration), { once: true });
  }));
  assert.ok(ready > 0, `video duration ${ready}`);

  await dialog.getByRole('tab', { name: 'Email' }).click();
  const mail = await dialog.locator('.mail').innerText();
  assert.match(mail, /Draft - not sent/);
  assert.match(mail, /I built Kapihan sa Kanto a website/);
  assert.match(mail, /Not interested\? Reply "no thanks"/);
  await page.screenshot({ path: join(SHOTS, 'dashboard-preview-email.png') });

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await button.evaluate((b) => b === document.activeElement), true, 'focus returns to the opener');
  await page.close();
});

test('retry: fixing the lead and retrying the failed stage turns it done', async () => {
  const store = new JsonStore(join(dirs[0]!, 'leads.json'));
  await store.update('fixture/2', { email: 'orders@lolanena.example.net' });

  const page = await open('/pipeline');
  const retry = page.getByRole('button', { name: "Retry email for Lola Nena's Kusina" });
  await retry.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const tr = Array.from(document.querySelectorAll('tbody tr')).find((r) => r.textContent?.includes('Lola Nena'));
    return tr?.querySelectorAll('.pill-done').length === 4;
  }, undefined, { timeout: 30_000 });
  assert.match(await row(page, "Lola Nena's Kusina").innerText(), /2 attempts/);
  await page.getByText('Job finished').waitFor();
  await page.close();
});

test('form validation: an area with leads ready, and a bounded whole number', async () => {
  const page = await open('/pipeline');
  await page.locator('tbody tr').first().waitFor();
  await page.getByLabel('Area', { exact: true }).selectOption('');
  await page.getByRole('button', { name: 'Build demos' }).click();
  assert.equal(await page.getByLabel('Area', { exact: true }).getAttribute('aria-invalid'), 'true');
  assert.equal(await page.getByLabel('Area', { exact: true }).evaluate((e) => e === document.activeElement), true);
  assert.match(await page.locator('#area-err').innerText(), /Choose an area/);

  await page.getByLabel('Area', { exact: true }).selectOption('katipunan');
  for (const bad of ['0', '11', '2.5']) {
    await page.getByLabel('How many leads').fill(bad);
    await page.getByRole('button', { name: 'Build demos' }).click();
    assert.equal(await page.getByLabel('How many leads').getAttribute('aria-invalid'), 'true', bad);
    assert.match(await page.locator('#limit-err').innerText(), /whole number|from 1 to 10/, bad);
  }
  await page.screenshot({ path: join(SHOTS, 'dashboard-validation.png') });

  // A valid number, but every fixture is already built: the area says so up front.
  assert.match(await page.getByLabel('Area', { exact: true }).locator('option:checked').innerText(), /0 ready/);
  await page.getByLabel('How many leads').fill('2');
  await page.getByRole('button', { name: 'Build demos' }).click();
  assert.match(await page.locator('#area-err').innerText(), /No leads in this area are ready/);
  assert.equal(await page.getByLabel('How many leads').getAttribute('aria-invalid'), 'false');
  await page.close();
});

test('the API refuses bad input on its own, whatever the page does', async () => {
  const post = (path: string, body: unknown) => fetch(seeded.url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post('/api/pipeline/run', { area: 'katipunan', limit: 99 })).status, 400);
  assert.equal((await post('/api/pipeline/run', { area: 'nowhere', limit: 1 })).status, 400);
  const none = await post('/api/pipeline/run', { area: 'katipunan', limit: 2 });
  assert.equal(none.status, 400, 'nothing ready is refused server-side too');
  assert.match((await none.json() as { error: string }).error, /no verified tier-A leads/);
  assert.equal((await post('/api/pipeline/retry', { lead_id: 'fixture/1', stage: 'deploy' })).status, 400);
  assert.equal((await post('/api/pipeline/retry', { lead_id: 'nope/1', stage: 'site' })).status, 404);
  const garbled = await fetch(`${seeded.url}/api/pipeline/run`, { method: 'POST', body: '{not json' });
  assert.equal(garbled.status, 400);
  assert.equal((await fetch(`${seeded.url}/sites/..%2f..%2fpackage.json`)).status, 404);
});

test('phone width: no sideways scroll, rows become cards, the form still works', async () => {
  const page = await open('/pipeline', seeded, { width: 375, height: 800 });
  await page.locator('tbody tr').first().waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `scrolls sideways by ${overflow}px`);
  assert.equal(await page.locator('.board thead').evaluate((e) => getComputedStyle(e).position), 'absolute');
  assert.ok(await page.getByRole('button', { name: 'Build demos' }).isVisible());
  await page.screenshot({ path: join(SHOTS, 'dashboard-mobile.png'), fullPage: true });
  await page.close();
});

test('keyboard: the skip link and every control are reachable', async () => {
  const page = await open('/pipeline');
  await page.locator('tbody tr').first().waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to lead status');
  const reached = new Set<string>();
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    reached.add(await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a?.getAttribute('aria-label') || a?.id || a?.textContent?.trim() || '';
    }));
  }
  for (const want of ['refresh', 'area', 'limit', 'runbtn', 'Preview site, video and email for Kapihan sa Kanto']) {
    assert.ok(reached.has(want), `never reached ${want} by Tab`);
  }
  await page.close();
});

test('accessibility: axe finds no violations on the dashboard or the open preview', async () => {
  const page = await open('/pipeline');
  await page.locator('tbody tr').first().waitFor();
  const board = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(board.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`), []);

  await page.getByRole('button', { name: 'Preview site, video and email for Kapihan sa Kanto' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('tab', { name: 'Email' }).click();
  const dialog = await new AxeBuilder({ page }).include('#preview').analyze();
  assert.deepEqual(dialog.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`), []);
  await page.close();
});

test('no console errors on any dashboard page', () => {
  assert.deepEqual(consoleErrors, []);
});
