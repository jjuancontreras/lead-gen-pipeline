import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLead, type Lead } from '../src/lead.ts';
import { dashboardView, SingleJob } from '../src/pipeline/dashboard.ts';
import type { StateFile } from '../src/pipeline/schemas.ts';

const lead = (id: string, name: string): Lead => ({ ...emptyLead(), lead_id: id, name, category: 'Cafe', area: 'katipunan' });

const site = { slug: 'kuro-n-1', dir: 'd', indexPath: 'd/index.html', url: 'https://demos.example.com/sites/kuro-n-1/', bytes: 10 };

const STATE: StateFile = {
  version: 1,
  leads: {
    'n/1': {
      find: { status: 'done', attempts: 1 },
      site: { status: 'done', attempts: 1, output: site },
      video: { status: 'failed', attempts: 2, error: 'ffmpeg missing' },
    },
    'n/2': { find: { status: 'running', attempts: 1 } },
  },
};

test('one row per lead the pipeline has touched, named from the store, sorted', () => {
  const v = dashboardView([lead('n/2', 'Anvil'), lead('n/1', 'Kuro'), lead('n/9', 'Untouched')], STATE);
  assert.deepEqual(v.rows.map((r) => r.name), ['Anvil', 'Kuro']);
});

test('each stage cell carries status, attempts and the error', () => {
  const kuro = dashboardView([lead('n/1', 'Kuro')], STATE).rows.find((r) => r.lead_id === 'n/1')!;
  assert.deepEqual(kuro.stages.video, { status: 'failed', attempts: 2, error: 'ffmpeg missing' });
  assert.deepEqual(kuro.stages.email, { status: 'pending', attempts: 0 });
});

test('previews appear only for done stages, as local console paths', () => {
  const kuro = dashboardView([lead('n/1', 'Kuro')], STATE).rows.find((r) => r.lead_id === 'n/1')!;
  assert.equal(kuro.preview.siteUrl, '/sites/kuro-n-1/');
  assert.equal(kuro.preview.videoUrl, undefined);
  assert.equal(kuro.preview.email, undefined);
});

test('counts add up per stage', () => {
  const v = dashboardView([], STATE);
  assert.deepEqual(v.counts.find, { pending: 0, running: 1, done: 1, failed: 0 });
  assert.deepEqual(v.counts.video, { pending: 1, running: 0, done: 0, failed: 1 });
});

test('a lead missing from the store still shows, by id', () => {
  assert.equal(dashboardView([], STATE).rows.find((r) => r.lead_id === 'n/1')!.name, 'n/1');
});

test('SingleJob refuses a second job while one runs, and records a failure', async () => {
  const job = new SingleJob();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  assert.equal(job.start('first', () => gate), true);
  assert.equal(job.start('second', async () => {}), false);
  assert.equal(job.status().label, 'first');
  release();
  await gate;
  await new Promise((r) => setImmediate(r));
  assert.equal(job.status().running, false);

  assert.equal(job.start('boom', async () => { throw new Error('nope'); }), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(job.status(), { running: false, lastError: 'nope' });
});
