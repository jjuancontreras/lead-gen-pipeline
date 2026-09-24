/**
 * End-to-end dry run: three fixture businesses through all four stages.
 *
 *   npm run e2e
 *
 * Runs the real CLI (`bin/pipeline.ts --fixtures`) in a child process against
 * a throwaway data directory and the JSON store, with no network access
 * needed, then checks every artifact independently:
 *
 *   - each lead was loaded into the store
 *   - each site renders in headless Chromium, on desktop and phone widths
 *   - each video exists and ffprobe reports a non-zero duration
 *   - each email draft names the business, links the site and the video,
 *     carries the opt-out line and no unfilled placeholder
 *   - zero emails were sent
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright';
import { JsonStore } from '../../src/store.ts';
import { PipelineState } from '../../src/pipeline/state.ts';
import { STAGE_NAMES, EmailDraft, SiteArtifact, VideoArtifact } from '../../src/pipeline/schemas.ts';
import { loadFixtureLeads } from '../../src/pipeline/leads.ts';
import { startStaticServer, type StaticServer } from '../../src/static-server.ts';
import { OPT_OUT_MARKER } from '../../src/outreach.ts';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'businesses.json');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const fixtures = loadFixtureLeads(FIXTURES);

const dataDir = mkdtempSync(join(tmpdir(), 'pipeline-e2e-'));
let run: { code: number | null; stdout: string; stderr: string };
let browser: Browser;
let sites: StaticServer;

before(async () => {
  run = await new Promise((done) => {
    const child = spawn(process.execPath, [TSX, 'bin/pipeline.ts', '--fixtures', FIXTURES], {
      cwd: ROOT,
      env: {
        ...process.env,
        PIPELINE_DATA_DIR: dataDir,
        PIPELINE_STORE: 'json',
        SEND_EMAILS: 'false',
        SENDER_EMAIL: 'sender@example.com',
        PIPELINE_VIDEO_MS: '5000',
        LOG_FORMAT: 'pretty',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => { stdout += b; process.stdout.write(b); });
    child.stderr.on('data', (b: Buffer) => { stderr += b; process.stdout.write(b); });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
  browser = await chromium.launch();
  sites = await startStaticServer(join(dataDir, 'sites'));
});

after(async () => {
  await browser?.close();
  await sites?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const state = () => new PipelineState(join(dataDir, 'pipeline-state.json'));

test('the CLI exits cleanly and reports every lead fully done', () => {
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /3 lead\(s\): 3 fully done, 0 failed/);
});

test('every stage of every fixture business is "done"', () => {
  const s = state();
  for (const f of fixtures) {
    for (const stage of STAGE_NAMES) {
      const entry = s.entry(f.lead_id, stage);
      assert.equal(entry.status, 'done', `${f.name} ${stage}: ${entry.error ?? ''}`);
    }
  }
});

test('each lead was loaded into the store and carries its demo links', async () => {
  const leads = await new JsonStore(join(dataDir, 'leads.json')).all();
  for (const f of fixtures) {
    const l = leads.find((x) => x.lead_id === f.lead_id);
    assert.ok(l, `${f.name} not in the store`);
    assert.equal(l.name, f.name);
    assert.equal(l.status, 'demo_built');
    assert.match(l.demo_url, /\/sites\//);
    assert.match(l.video_url, /\.mp4$/);
  }
});

test('each site renders in a headless browser, on desktop and on a phone, fully offline', async () => {
  for (const f of fixtures) {
    const site = SiteArtifact.parse(state().entry(f.lead_id, 'site').output);
    for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 740 }]) {
      const page = await browser.newPage({ viewport });
      const errors: string[] = [];
      const offsite: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => { if (!r.url().startsWith(sites.url)) offsite.push(r.url()); });

      const res = await page.goto(`${sites.url}/${site.slug}/`);
      assert.equal(res?.status(), 200);
      assert.equal((await page.locator('h1').textContent())?.trim(), f.name);
      assert.ok(await page.locator('footer').isVisible());
      // A string, not a callback: this is a Node project with no DOM types.
      const overflow = await page.evaluate<number>(
        'document.documentElement.scrollWidth - document.documentElement.clientWidth');
      assert.ok(overflow <= 0, `${f.name} scrolls sideways by ${overflow}px at ${viewport.width}px`);
      assert.deepEqual(errors, [], `${f.name}: console errors`);
      assert.deepEqual(offsite, [], `${f.name}: loaded something from the network`);
      await page.close();
    }
  }
});

test('each video exists and has a real, non-zero duration', async () => {
  for (const f of fixtures) {
    const video = VideoArtifact.parse(state().entry(f.lead_id, 'video').output);
    assert.ok(existsSync(video.path), video.path);
    assert.ok(statSync(video.path).size > 10_000, `${f.name}: video is suspiciously small`);
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', video.path,
    ]);
    const seconds = Number(stdout.trim());
    assert.ok(seconds > 1, `${f.name}: ffprobe says ${seconds}s`);
  }
});

test('each email draft has the name, both links, the opt-out line and no placeholders', () => {
  for (const f of fixtures) {
    const email = EmailDraft.parse(state().entry(f.lead_id, 'email').output);
    const file = readFileSync(email.path, 'utf8');
    assert.equal(email.to, f.email);
    assert.ok(email.subject.includes(f.name), `${f.name}: subject`);
    for (const [needle, what] of [
      [f.name, 'business name'], [email.siteUrl, 'site link'], [email.videoUrl, 'video link'],
      [OPT_OUT_MARKER, 'opt-out line'], ['sender@example.com', 'sender address'],
    ] as const) {
      assert.ok(email.body.includes(needle), `${f.name}: body is missing the ${what}`);
      assert.ok(file.includes(needle), `${f.name}: draft file is missing the ${what}`);
    }
    assert.doesNotMatch(email.subject + email.body + file, /\{\{|\}\}/, `${f.name}: unfilled placeholder`);
    assert.match(email.siteUrl, /\/sites\/[a-z0-9-]+\/$/);
    assert.match(email.videoUrl, /\/videos\/[a-z0-9-]+\/[a-z0-9-]+-16x9\.mp4$/);
    assert.equal(dirname(email.path), join(dataDir, 'emails'));
  }
});

test('CRITICAL: zero emails were sent', () => {
  assert.match(run.stdout, /emails sent: 0 /);
  assert.match(run.stdout, /sending: OFF/);
  for (const f of fixtures) {
    const email = EmailDraft.parse(state().entry(f.lead_id, 'email').output);
    assert.equal(email.sent, false, `${f.name} is recorded as sent`);
  }
});

test('a second run is a no-op: nothing is rebuilt', async () => {
  const before = Object.fromEntries(fixtures.map((f) => [f.lead_id, state().entry(f.lead_id, 'video').attempts]));
  const again = await new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(process.execPath, [TSX, 'bin/pipeline.ts', '--fixtures', FIXTURES], {
      cwd: ROOT,
      env: { ...process.env, PIPELINE_DATA_DIR: dataDir, PIPELINE_STORE: 'json', SENDER_EMAIL: 'sender@example.com' },
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b; });
    child.on('close', (code) => done({ code, out }));
  });
  assert.equal(again.code, 0);
  for (const f of fixtures) {
    assert.equal(state().entry(f.lead_id, 'video').attempts, before[f.lead_id], `${f.name} was re-recorded`);
  }
});
