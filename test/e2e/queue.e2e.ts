/**
 * The Work Queue, end to end, in headless Chromium against the real console.
 *
 *   npm run e2e
 *
 * Seeds a throwaway JSON store with a fictional lead in every group, points
 * DEMO_SITES_ROOT at a temp folder, and serves a small local page standing in
 * for a deployed Vercel demo. Then it walks the whole Tier-2 craft loop the
 * way you would - choose, Build demo, Mark built, Record, set the video,
 * Draft pitch, Mark pitch sent - plus hand verification, sending a draft,
 * logging a conversation, every page state, the API's refusals, phone width,
 * keyboard reach and an axe scan. Nothing is sent; no page may log an error.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page, type ConsoleMessage } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { JsonStore } from '../../src/store.ts';
import { today } from '../../src/dates.ts';
import { startStaticServer, type StaticServer } from '../../src/static-server.ts';
import { seedQueue, SEEDED } from '../helpers/seed-queue.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
// Git-ignored, so a test run never dirties the tree.
const SHOTS = join(ROOT, 'test-results', 'queue');

interface Console { url: string; child: ChildProcess }

async function startConsole(dataDir: string, demoRoot: string): Promise<Console> {
  const child = spawn(process.execPath, [TSX, 'bin/console.ts'], {
    cwd: ROOT,
    env: {
      ...process.env, PIPELINE_DATA_DIR: dataDir, PIPELINE_STORE: 'json', CONSOLE_PORT: '0',
      DEMO_SITES_ROOT: demoRoot, SENDER_EMAIL: 'sender@example.com', SEND_EMAILS: 'false',
      PORTFOLIO_URLS: '', PIPELINE_VIDEO_MS: '5000', LOG_LEVEL: 'warn',
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

/**
 * A few tall sections, like a real demo, so the recorder has a walk to film.
 * The hero has real visual weight - big type on a gradient with colour
 * blocks - because the mockup capture rightly refuses a page that looks blank.
 */
function writeFakeDemo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const blocks = ['#7a3b1e', '#c8743a', '#e9c46a', '#2a9d8f', '#264653']
    .map((c) => `<div style="height:120px;background:${c};border-radius:12px"></div>`).join('');
  const hero = `<section data-section="hero" style="min-height:92vh;padding:64px;color:#fff;
    background:linear-gradient(135deg,#3b1f10,#a0522d 55%,#f4a261)">
    <h1 style="font-size:88px;margin:0 0 24px">Kapihan sa Kanto</h1>
    <p style="font-size:28px;max-width:720px">Coffee and Filipino merienda in Katipunan, brewed since 2019.</p>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin-top:48px">${blocks}</div></section>`;
  const section = (n: number, color: string) =>
    `<section data-section="s${n}" style="min-height:90vh;padding:48px;background:${color}"><h2>Section ${n}</h2><p>Menu, hours and how to find us.</p></section>`;
  writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Kapihan sa Kanto</title></head>
<body style="margin:0;font-family:sans-serif"><main>${hero}${section(2, '#dce8f3')}${section(3, '#e3f3dc')}</main>
<footer style="padding:32px">Demo footer</footer></body></html>`);
}

let browser: Browser;
let seeded: Console;
let empty: Console;
let demo: StaticServer;
let demoUrl: string;
const dirs: string[] = [];
let dataDir = '';
let demoRoot = '';
const consoleErrors: string[] = [];

async function open(base: Console = seeded, viewport = { width: 1280, height: 900 }): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('dialog', (d) => { void d.accept(); }); // the confirm() on irreversible buttons
  await page.goto(`${base.url}/queue`);
  await page.locator('#groups[aria-busy="false"]').waitFor();
  return page;
}

/** Which rule, and exactly which elements break it. */
const describeViolation = (v: { id: string; nodes: { target: unknown[]; failureSummary?: string }[] }) =>
  `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} - ${n.failureSummary?.split('\n').pop() ?? ''}`).join(' | ')}`;

/** Wait for the side sheet to finish sliding in, before judging or photographing it. */
const sheetSettled = (page: Page) => page.waitForFunction(() => {
  const r = document.getElementById('dlg')!.getBoundingClientRect();
  return Math.abs(r.right - window.innerWidth) < 1 && r.left >= 0;
});

const card = (page: Page, id: string) => page.locator(`article[data-lead="${id}"]`);
const inGroup = (page: Page, group: string, id: string) => page.locator(`#g-${group} article[data-lead="${id}"]`);
const storeLead = async (id: string) => (await new JsonStore(join(dataDir, 'leads.json')).all()).find((l) => l.lead_id === id)!;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'queue-data-'));
  demoRoot = mkdtempSync(join(tmpdir(), 'queue-demos-'));
  const emptyDir = mkdtempSync(join(tmpdir(), 'queue-empty-'));
  const demoDir = mkdtempSync(join(tmpdir(), 'queue-live-'));
  dirs.push(dataDir, demoRoot, emptyDir, demoDir);
  await seedQueue(dataDir, today());
  writeFakeDemo(demoDir);
  demo = await startStaticServer(demoDir);
  demoUrl = `${demo.url}/`;
  [seeded, empty] = await Promise.all([startConsole(dataDir, demoRoot), startConsole(emptyDir, demoRoot)]);
  browser = await chromium.launch();
  mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  await browser?.close();
  await demo?.close();
  seeded?.child.kill();
  empty?.child.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('every group lists the leads waiting on you, with counts and setup warnings', async () => {
  const page = await open();
  const summary = await page.locator('#summary').innerText();
  for (const [label, n] of [['Verify by hand', 2], ['Choose demos', 1], ['Build', 1], ['Record', 0],
    ['Pitch', 0], ['Drafts to send', 1], ['Follow-ups due', 1], ['Conversations', 1]] as const) {
    assert.match(summary, new RegExp(`${label}\\s+${n}`), label);
  }
  assert.ok(await inGroup(page, 'choose', SEEDED.choose).isVisible());
  assert.match(await page.locator('#g-verify').innerText(), /1 more not verified yet/);
  assert.match(await page.locator('#setup').innerText(), /PORTFOLIO_URLS is empty/);
  await page.screenshot({ path: join(SHOTS, 'queue-desktop.png'), fullPage: true });
  await page.close();
});

test('loading state: a skeleton, marked busy, until the data arrives', async () => {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/queue**', async (route) => { await gate; await route.continue(); });
  await page.goto(`${seeded.url}/queue`);
  await page.locator('#groups .skel').first().waitFor();
  assert.equal(await page.locator('#groups').getAttribute('aria-busy'), 'true');
  release();
  await page.locator('#groups[aria-busy="false"]').waitFor();
  await page.close();
});

test('empty state: every group says nothing is waiting', async () => {
  const page = await open(empty);
  assert.equal(await page.locator('.qempty').count(), 8);
  assert.equal(await page.locator('article.qc').count(), 0);
  await page.close();
});

test('error state: a failed load explains itself and recovers on Try again', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  let fail = true;
  await page.route('**/api/queue**', (route) => (fail
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'sheet unreachable' }) })
    : route.continue()));
  await page.goto(`${seeded.url}/queue`);
  await page.getByRole('alert').filter({ hasText: 'Could not load the Work Queue' }).waitFor();
  assert.match(await page.locator('#groups').innerText(), /sheet unreachable/);
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.locator('article.qc').first().waitFor();
  assert.ok(errors.every((e) => /status of 500/.test(e)), errors.join('\n'));
  await page.close();
});

test('the area filter narrows the queue', async () => {
  const page = await open();
  assert.ok(await card(page, SEEDED.otherArea).isVisible());
  await page.getByLabel('Area').selectOption('katipunan');
  await card(page, SEEDED.otherArea).waitFor({ state: 'detached' });
  assert.ok(await card(page, SEEDED.verify).isVisible());
  await page.close();
});

test('verify by hand: the form refuses nothing-found and a bad email, then records a verification', async () => {
  const page = await open();
  const c = card(page, SEEDED.verify);
  await c.getByRole('button', { name: 'Verify', exact: true }).click();
  const form = c.locator('form.qc-verify');
  await form.getByRole('button', { name: 'Save verification' }).click();
  await form.getByText(/enter a website or at least one contact/).waitFor();

  await form.getByLabel('Email').fill('not-an-email');
  await form.getByLabel('Facebook').fill('lolanenaskusina');
  await form.getByRole('button', { name: 'Save verification' }).click();
  await form.getByText(/not a valid email address/).waitFor();
  assert.equal(await form.getByLabel('Email').getAttribute('aria-invalid'), 'true');

  await form.getByLabel('Email').fill('orders@lolanena.example.net');
  await form.getByRole('button', { name: 'Save verification' }).click();
  await inGroup(page, 'verify', SEEDED.verify).waitFor({ state: 'detached' });
  const l = await storeLead(SEEDED.verify);
  assert.equal(l.verify_method, 'manual');
  assert.equal(l.has_website, 'no');
  assert.ok(l.tier, 'scored into a tier');
  await page.close();
});

test('Tier 2: choose a lead, then Build demo scaffolds its folder and BUILD-PROMPT', async () => {
  const page = await open();
  await card(page, SEEDED.choose).getByRole('button', { name: 'Build a demo for this: Kapihan sa Kanto' }).click();
  const building = inGroup(page, 'build', SEEDED.choose);
  await building.waitFor();
  await building.getByRole('button', { name: 'Build demo: Kapihan sa Kanto' }).click();
  const dialog = page.getByRole('dialog', { name: /Demo kit - Kapihan sa Kanto/ });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /BUILD-PROMPT-/);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });

  const folder = join(demoRoot, 'kapihan-sa-kanto');
  assert.ok(existsSync(join(folder, 'src', 'data', 'content.json')));
  assert.ok(readdirSync(folder).some((f) => f.startsWith('BUILD-PROMPT-')));
  const l = await storeLead(SEEDED.choose);
  assert.equal(l.status, 'scaffolded');
  assert.equal(l.demo_slug, 'kapihan-sa-kanto');
  await page.close();
});

test('Tier 2: Mark built refuses a partial address, then takes the live URL', async () => {
  const page = await open();
  const c = inGroup(page, 'build', SEEDED.choose);
  const url = c.getByLabel('Live demo URL');
  await url.fill('kapihan.vercel');
  await c.getByRole('button', { name: 'Mark built' }).click();
  await c.getByText(/full address/).waitFor();
  assert.equal(await url.getAttribute('aria-invalid'), 'true');

  await url.fill(demoUrl);
  await c.getByRole('button', { name: 'Mark built' }).click();
  await inGroup(page, 'record', SEEDED.choose).waitFor();
  assert.equal((await storeLead(SEEDED.choose)).demo_url, demoUrl);
  await page.close();
});

test('Tier 2: Record films the live demo, and the take plays in the dialog', async () => {
  const page = await open();
  const c = inGroup(page, 'record', SEEDED.choose);
  await c.getByRole('button', { name: 'Record the live demo: Kapihan sa Kanto' }).click();
  await page.locator('#jobbar').filter({ hasText: /record Kapihan/ }).waitFor();
  await c.getByRole('button', { name: 'Watch the recording: Kapihan sa Kanto' }).waitFor({ timeout: 180_000 });

  const takes = join(demoRoot, 'kapihan-sa-kanto', 'public', 'demo');
  for (const f of ['kapihan-sa-kanto-16x9.mp4', 'kapihan-sa-kanto-9x16.mp4', 'kapihan-sa-kanto-hero.png']) {
    assert.ok(existsSync(join(takes, f)) && statSync(join(takes, f)).size > 1000, `${f} missing or empty`);
  }
  await c.getByRole('button', { name: 'Watch the recording: Kapihan sa Kanto' }).click();
  const video = page.getByRole('dialog').locator('video');
  const duration = await video.evaluate((v: HTMLVideoElement) => new Promise<number>((ok) => {
    if (v.readyState >= 1) ok(v.duration);
    else v.addEventListener('loadedmetadata', () => ok(v.duration), { once: true });
  }));
  assert.ok(duration > 1, `video duration ${duration}`);
  await sheetSettled(page);
  await page.screenshot({ path: join(SHOTS, 'queue-recording.png') });
  await page.keyboard.press('Escape');
  await page.close();
});

test('Tier 2: the video link is prefilled where the redeploy will host it; setting it readies the pitch', async () => {
  const page = await open();
  const c = inGroup(page, 'record', SEEDED.choose);
  const link = c.getByLabel('Hosted video link');
  assert.equal(await link.inputValue(), `${demoUrl}demo/kapihan-sa-kanto-16x9.mp4`);
  await c.getByRole('button', { name: 'Set video link' }).click();
  await inGroup(page, 'pitch', SEEDED.choose).waitFor();
  await page.close();
});

test('Tier 2: Draft pitch writes the email; Mark pitch sent starts the follow-up clock', async () => {
  const page = await open();
  const c = inGroup(page, 'pitch', SEEDED.choose);
  const sentBtn = c.getByRole('button', { name: 'Mark pitch sent: Kapihan sa Kanto' });
  assert.equal(await sentBtn.isDisabled(), true, 'locked until a draft exists');
  await c.getByRole('button', { name: 'Draft the pitch: Kapihan sa Kanto' }).click();
  const dialog = page.getByRole('dialog', { name: /Pitch - Kapihan sa Kanto/ });
  await dialog.waitFor();
  const mail = await dialog.innerText();
  for (const needle of ['Draft - not sent', 'hello@kapihan.example.com', 'I built Kapihan sa Kanto a website',
    demoUrl, `${demoUrl}demo/kapihan-sa-kanto-16x9.mp4`, 'sender@example.com', 'Not interested? Reply "no thanks"']) {
    assert.ok(mail.includes(needle), `pitch is missing ${needle}`);
  }
  await sheetSettled(page);
  await page.screenshot({ path: join(SHOTS, 'queue-pitch.png') });
  await page.keyboard.press('Escape');

  await inGroup(page, 'pitch', SEEDED.choose).getByRole('button', { name: 'Mark pitch sent: Kapihan sa Kanto' }).click();
  await inGroup(page, 'conversations', SEEDED.choose).waitFor();
  const l = await storeLead(SEEDED.choose);
  assert.equal(l.status, 'demo_sent');
  assert.equal(l.first_contacted_at, today());
  assert.ok(l.next_action_date > today(), 'a follow-up is scheduled');
  const draft = readdirSync(join(dataDir, 'drafts')).find((f) => f.endsWith('-demo.md'));
  assert.ok(draft, 'pitch draft file written');
  assert.match(readFileSync(join(dataDir, 'drafts', draft), 'utf8'), /Nothing here has been sent/);
  await page.close();
});

test('Tier 1: Mark as sent moves a draft into conversations', async () => {
  const page = await open();
  await card(page, SEEDED.send).getByRole('button', { name: 'Mark as sent: Tindahan ni Aling Rosa' }).click();
  await inGroup(page, 'conversations', SEEDED.send).waitFor();
  assert.equal((await storeLead(SEEDED.send)).status, 'tier1_sent');
  await page.close();
});

test('conversations: logging a meeting moves the lead on', async () => {
  const page = await open();
  await card(page, SEEDED.conversations).getByRole('button', { name: 'Meeting booked: Pansitan sa Kanto' }).click();
  await page.waitForFunction((id) =>
    document.querySelector(`article[data-lead="${id}"]`)?.textContent?.includes('Meeting'), SEEDED.conversations);
  assert.equal((await storeLead(SEEDED.conversations)).status, 'meeting');
  await page.close();
});

test('the API refuses what the page would never send', async () => {
  const post = (path: string, body: unknown) => fetch(seeded.url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post('/api/queue/transition', { lead_id: SEEDED.followup, action: 'teleport' })).status, 400);
  assert.equal((await post('/api/queue/transition', { lead_id: SEEDED.followup, action: 'scaffolded' })).status, 400,
    'scaffolded is only ever recorded by Build demo');
  assert.equal((await post('/api/queue/transition', { lead_id: 'nope/1', action: 'lost' })).status, 404);
  assert.equal((await post('/api/queue/transition', { lead_id: SEEDED.followup, action: 'mark_built', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await post('/api/queue/verify', { lead_id: SEEDED.verify, answers: { facebook: 'x' } })).status, 400, 'already verified');
  assert.equal((await post('/api/queue/verify', { lead_id: SEEDED.otherArea, answers: { bogus: 'x' } })).status, 400, 'unknown field');
  assert.equal((await post('/api/queue/build', { lead_id: SEEDED.followup })).status, 400, 'not queued for a demo');
  assert.equal((await post('/api/queue/record', { lead_id: SEEDED.followup })).status, 400, 'not built');
  assert.equal((await post('/api/queue/verify-run', { area: 'nowhere' })).status, 400);
  assert.equal((await fetch(`${seeded.url}/demo-files/..%2f..%2fetc`)).status, 404);
  assert.equal((await fetch(`${seeded.url}/demo-files/kapihan-sa-kanto/src/data/content.json`)).status, 404,
    'only recordings are served, not the demo source');
});

function rawStatus(path: string, headers: Record<string, string>, method = 'GET'): Promise<number> {
  const { port } = new URL(seeded.url);
  return new Promise((ok, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
    req.on('error', fail);
    req.end();
  });
}

test('CRITICAL: the console refuses DNS-rebinding and cross-site requests', async () => {
  const host = `localhost:${new URL(seeded.url).port}`;
  assert.equal(await rawStatus('/api/queue', { Host: 'evil.example' }), 403);
  assert.equal(await rawStatus('/api/queue', { Host: host, 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.equal(await rawStatus('/api/queue/transition', { Host: host, 'Content-Type': 'text/plain' }, 'POST'), 403);
  assert.equal(await rawStatus('/api/queue', { Host: host }), 200);
});

test('phone width: no sideways scroll, and cards stack', async () => {
  const page = await open(seeded, { width: 375, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `scrolls sideways by ${overflow}px`);
  await page.screenshot({ path: join(SHOTS, 'queue-mobile.png'), fullPage: true });
  await page.close();
});

test('keyboard: the skip link and the controls are reachable by Tab', async () => {
  const page = await open();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to the queue');
  const reached = new Set<string>();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    reached.add(await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a?.getAttribute('aria-label') || a?.id || a?.textContent?.trim() || '';
    }));
  }
  for (const want of ['area', 'refresh', 'Google Maps', 'Verify']) assert.ok(reached.has(want), `never reached ${want}`);
  await page.close();
});

test('accessibility: axe finds no violations on the queue or an open dialog', async () => {
  const page = await open();
  const queue = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(queue.violations.map(describeViolation), []);
  // Café Ñora is still queued: Build demo opens the kit dialog.
  await card(page, SEEDED.build).getByRole('button', { name: /^Build demo: / }).click();
  await page.getByRole('dialog', { name: /Demo kit/ }).waitFor();
  const dialog = await new AxeBuilder({ page }).include('#dlg').analyze();
  assert.deepEqual(dialog.violations.map(describeViolation), []);
  await page.close();
});

test('no console errors on any Work Queue page', () => {
  assert.deepEqual(consoleErrors, []);
});
