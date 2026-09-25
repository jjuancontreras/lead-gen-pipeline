import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { emptyLead, type Lead } from '../src/lead.ts';
import { workQueue } from '../src/work-queue.ts';
import { queueView, type QueueEnv } from '../src/queue-view.ts';

function lead(id: string, over: Partial<Lead> = {}): Lead {
  return { ...emptyLead(), lead_id: id, name: `Biz ${id}`, category: 'Cafe', area: 'katipunan', osm_score: '5', ...over };
}

const env = (existing: string[] = []): QueueEnv => ({
  areaLabel: () => 'Katipunan, QC',
  demoRoot: '/demos',
  draftsDir: '/drafts',
  senderEmail: 'me@example.com',
  exists: (p) => existing.includes(p),
});

const view = (leads: Lead[], e = env()) => queueView(workQueue(leads, { today: '2026-09-25' }), e);

test('verify cards carry the four search links', () => {
  const v = view([lead('m', { status: 'needs_manual' })]);
  const links = v.groups.verify[0]!.lead.links!;
  assert.deepEqual(Object.keys(links).sort(), ['facebook', 'instagram', 'maps', 'web']);
  assert.equal(v.groups.verify[0]!.lead.areaLabel, 'Katipunan, QC');
});

test('record cards know whether the take exists and where the video will be hosted', () => {
  const l = lead('r', { status: 'demo_built', demo_slug: 'kuro', demo_url: 'https://kuro.vercel.app' });
  const before = view([l]).groups.record[0]!.lead;
  assert.equal(before.recorded, false);
  assert.equal(before.suggestedVideoUrl, 'https://kuro.vercel.app/demo/kuro-16x9.mp4');
  const after = view([l], env([join('/demos', 'kuro', 'public', 'demo', 'kuro-16x9.mp4')])).groups.record[0]!.lead;
  assert.equal(after.recorded, true);
});

test('pitch cards say whether a pitch can be drafted, and whether one is', () => {
  const ready = lead('p', { status: 'demo_built', demo_url: 'https://k.app', video_url: 'https://k.app/v.mp4', email: 'o@k.example.com' });
  assert.deepEqual(view([ready]).groups.pitch[0]!.lead.pitch, { refusal: null, drafted: false });
  const noEmail = view([{ ...ready, email: '' }]).groups.pitch[0]!.lead.pitch!;
  assert.match(noEmail.refusal!, /no email address/);
});

test('cards carry only the columns the page uses, not the whole record', () => {
  const c = view([lead('m', { status: 'needs_manual', lat: '14.6', maps_url: 'https://maps' })]).groups.verify[0]!.lead;
  assert.equal('lat' in c, false);
  assert.equal(c.name, 'Biz m');
});
