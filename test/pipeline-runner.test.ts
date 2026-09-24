/**
 * Runner behaviour (isolation, resume, validation at each handoff) and the
 * video -> email handoff with the real email stage. The browser-bound
 * site -> video handoff runs in the e2e test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyLead, type Lead } from '../src/lead.ts';
import { JsonStore } from '../src/store.ts';
import { createLogger } from '../src/log.ts';
import { PipelineState } from '../src/pipeline/state.ts';
import { runPipeline, errorMessage } from '../src/pipeline/runner.ts';
import { findStage } from '../src/pipeline/stages/find.ts';
import { siteStage } from '../src/pipeline/stages/site.ts';
import { emailStage } from '../src/pipeline/stages/email.ts';
import { NO_TRANSPORT, type Mailer, type OutgoingEmail } from '../src/pipeline/mailer.ts';
import { EmailDraft, type VideoArtifact } from '../src/pipeline/schemas.ts';
import { OPT_OUT_MARKER } from '../src/outreach.ts';
import type { PipelineStage, StageContext } from '../src/pipeline/stage.ts';

function lead(id: string, over: Partial<Lead> = {}): Lead {
  return {
    ...emptyLead(),
    lead_id: id, name: `Business ${id}`, category: 'Cafe', area: 'katipunan',
    has_website: 'no', website_kind: 'none', status: 'verified', tier: 'A',
    email: `owner-${id.replace(/\W/g, '')}@example.com`, phone: '0917 555 0101',
    ...over,
  };
}

function setup(over: Partial<StageContext> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pl-run-'));
  const ctx: StageContext = {
    dataDir,
    publicBaseUrl: 'http://localhost:3008',
    videoMs: 5000,
    sendEmails: false,
    mailer: NO_TRANSPORT,
    senderName: 'Jfer Contreras',
    senderEmail: 'sender@example.com',
    areaLabel: () => 'Katipunan, Quezon City',
    log: createLogger({ format: 'json', level: 'error', sink: () => {} }),
    ...over,
  };
  return { ctx, dataDir, state: new PipelineState(join(dataDir, 'pipeline-state.json')) };
}

/** A stand-in video stage: writes a small file instead of driving a browser. */
function fakeVideo(calls: { n: number } = { n: 0 }, fail?: (id: string) => boolean): PipelineStage<'video'> {
  return {
    name: 'video',
    description: 'fake',
    async run({ lead: l, site }, ctx) {
      calls.n++;
      if (fail?.(l.lead_id)) throw new Error('recorder crashed');
      const path = join(ctx.dataDir, `${site!.slug}.mp4`);
      writeFileSync(path, 'not really a video');
      const out: VideoArtifact = {
        path, url: `${ctx.publicBaseUrl}/videos/${site!.slug}/${site!.slug}-16x9.mp4`,
        durationMs: 6000, bytes: 18, width: 1920, height: 1080,
      };
      return out;
    },
    isIntact: () => true,
  };
}

const stagesWith = (video: PipelineStage<'video'>) => [findStage, siteStage, video, emailStage] as PipelineStage[];

test('every stage of every lead ends done, and each output is recorded', async () => {
  const { ctx, state } = setup();
  const summary = await runPipeline({ leads: [lead('a/1'), lead('a/2')], state, ctx, stages: stagesWith(fakeVideo()) });
  for (const r of summary.results) {
    assert.deepEqual(r.stages, { find: 'done', site: 'done', video: 'done', email: 'done' }, r.lead_id);
  }
  assert.equal(summary.emailsSent, 0);
  assert.equal(state.entry('a/1', 'email').attempts, 1);
});

test('CRITICAL: one lead failing does not stop the others, and later stages stay pending', async () => {
  const { ctx, state } = setup();
  const summary = await runPipeline({
    leads: [lead('b/1'), lead('b/2'), lead('b/3')], state, ctx,
    stages: stagesWith(fakeVideo({ n: 0 }, (id) => id === 'b/2')),
  });
  const byId = Object.fromEntries(summary.results.map((r) => [r.lead_id, r]));
  assert.equal(byId['b/1']!.stages.email, 'done');
  assert.equal(byId['b/3']!.stages.email, 'done');
  assert.deepEqual(byId['b/2']!.stages, { find: 'done', site: 'done', video: 'failed', email: 'pending' });
  assert.deepEqual(byId['b/2']!.error, { stage: 'video', message: 'recorder crashed' });
  assert.equal(state.entry('b/2', 'video').error, 'recorder crashed');
  assert.equal(state.entry('b/2', 'email').status, 'pending');
});

test('a rerun skips done stages and resumes a failed one', async () => {
  const { ctx, state } = setup();
  const calls = { n: 0 };
  let broken = true;
  const stages = stagesWith(fakeVideo(calls, () => broken));
  await runPipeline({ leads: [lead('c/1')], state, ctx, stages });
  assert.equal(state.entry('c/1', 'video').status, 'failed');

  broken = false;
  const second = await runPipeline({ leads: [lead('c/1')], state, ctx, stages });
  assert.equal(second.results[0]!.stages.email, 'done');
  assert.equal(state.entry('c/1', 'find').attempts, 1, 'find was not redone');
  assert.equal(state.entry('c/1', 'video').attempts, 2, 'video was retried once');

  await runPipeline({ leads: [lead('c/1')], state, ctx, stages });
  assert.equal(calls.n, 2, 'a fully done lead does no work at all');
});

test('a done stage whose file is gone is rebuilt, not trusted', async () => {
  const { ctx, state } = setup();
  const stages = stagesWith(fakeVideo());
  await runPipeline({ leads: [lead('d/1')], state, ctx, stages });
  const site = state.entry('d/1', 'site').output as { indexPath: string };
  rmSync(site.indexPath);
  await runPipeline({ leads: [lead('d/1')], state, ctx, stages });
  assert.equal(state.entry('d/1', 'site').attempts, 2);
  assert.ok(readFileSync(site.indexPath, 'utf8').includes('Business d/1'));
});

test('a stage left "running" by a crash is simply run again', async () => {
  const { ctx, state } = setup();
  state.update('e/1', 'find', { status: 'running', attempts: 1 });
  const summary = await runPipeline({ leads: [lead('e/1')], state, ctx, stages: stagesWith(fakeVideo()) });
  assert.equal(summary.results[0]!.stages.email, 'done');
  assert.equal(state.entry('e/1', 'find').attempts, 2);
});

test('CRITICAL: a malformed handoff fails at the stage that produced it', async () => {
  const { ctx, state } = setup();
  const badVideo: PipelineStage<'video'> = {
    ...fakeVideo(),
    async run() { return { path: 'x.mp4', url: 'not a url', durationMs: 0, bytes: 0, width: 1, height: 1 }; },
  };
  const summary = await runPipeline({ leads: [lead('f/1')], state, ctx, stages: stagesWith(badVideo) });
  const r = summary.results[0]!;
  assert.equal(r.stages.video, 'failed');
  assert.equal(r.stages.email, 'pending', 'the email stage never saw the bad artifact');
  assert.match(r.error!.message, /durationMs: video has no duration/);
  assert.match(r.error!.message, /url:/);
});

test('an opted-out lead fails at find and nothing is built for it', async () => {
  const { ctx, state } = setup();
  const summary = await runPipeline({
    leads: [lead('g/1', { do_not_contact: 'yes' })], state, ctx, stages: stagesWith(fakeVideo()),
  });
  assert.deepEqual(summary.results[0]!.stages, { find: 'failed', site: 'pending', video: 'pending', email: 'pending' });
});

test('fully done leads get their demo links written back, status advanced', async () => {
  const { ctx, state, dataDir } = setup();
  const store = new JsonStore(join(dataDir, 'leads.json'));
  await store.upsert([lead('h/1'), lead('h/2', { status: 'meeting' }), lead('h/3', { email: '' })]);
  await runPipeline({ leads: await store.all(), state, ctx, store, stages: stagesWith(fakeVideo()) });
  const after = Object.fromEntries((await store.all()).map((l) => [l.lead_id, l]));
  assert.equal(after['h/1']!.status, 'demo_built');
  assert.match(after['h/1']!.demo_url, /^http:\/\/localhost:3008\/sites\/business-h-1-h-1\/$/);
  assert.match(after['h/1']!.video_url, /\.mp4$/);
  assert.equal(after['h/2']!.status, 'meeting', 'never moved backwards');
  assert.equal(after['h/3']!.demo_url, '', 'a lead whose email stage failed gets no links');
});

// ---- the email stage and the send gate --------------------------------------

function spyMailer(): Mailer & { sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  return { sent, async send(e) { sent.push(e); } };
}

test('CRITICAL: with sending off, the mailer is never called', async () => {
  const mailer = spyMailer();
  const { ctx, state } = setup({ mailer, sendEmails: false });
  const summary = await runPipeline({ leads: [lead('i/1'), lead('i/2')], state, ctx, stages: stagesWith(fakeVideo()) });
  assert.equal(mailer.sent.length, 0);
  assert.equal(summary.emailsSent, 0);
  const out = EmailDraft.parse(state.entry('i/1', 'email').output);
  assert.equal(out.sent, false);
});

test('the gate is the only thing between a draft and a send', async () => {
  const mailer = spyMailer();
  const { ctx, state } = setup({ mailer, sendEmails: true });
  const summary = await runPipeline({ leads: [lead('j/1')], state, ctx, stages: stagesWith(fakeVideo()) });
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0]!.to, 'owner-j1@example.com');
  assert.equal(summary.emailsSent, 1);
});

test('the draft names the business, links site and video, signs off, and offers an opt-out', async () => {
  const { ctx, state } = setup();
  await runPipeline({ leads: [lead('k/1', { name: "Lola Nena's Kusina" })], state, ctx, stages: stagesWith(fakeVideo()) });
  const d = EmailDraft.parse(state.entry('k/1', 'email').output);
  assert.match(d.subject, /Lola Nena's Kusina/);
  for (const needle of [d.siteUrl, d.videoUrl, 'sender@example.com', 'Jfer Contreras', OPT_OUT_MARKER]) {
    assert.ok(d.body.includes(needle), `missing ${needle}`);
  }
  assert.doesNotMatch(d.body, /\{\{|\}\}/);
  const file = readFileSync(d.path, 'utf8');
  assert.match(file, /Nothing here has been sent/);
});

test('the email stage fails clearly without a recipient or a sender address', async () => {
  const noTo = setup();
  const r1 = await runPipeline({ leads: [lead('l/1', { email: '' })], state: noTo.state, ctx: noTo.ctx, stages: stagesWith(fakeVideo()) });
  assert.match(r1.results[0]!.error!.message, /no email address on record/);

  const noFrom = setup({ senderEmail: undefined });
  const r2 = await runPipeline({ leads: [lead('l/2')], state: noFrom.state, ctx: noFrom.ctx, stages: stagesWith(fakeVideo()) });
  assert.match(r2.results[0]!.error!.message, /SENDER_EMAIL is not set/);
});

test('errorMessage flattens zod issues into one readable line', () => {
  const r = EmailDraft.safeParse({});
  assert.ok(!r.success);
  assert.match(errorMessage(r.error), /^path: /);
  assert.equal(errorMessage(new Error('plain')), 'plain');
  assert.equal(errorMessage('str'), 'str');
});
