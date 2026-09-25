import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLead, type Lead } from '../src/lead.ts';
import { workQueue, QUEUE_GROUPS } from '../src/work-queue.ts';

const TODAY = '2026-09-25';

function lead(id: string, over: Partial<Lead> = {}): Lead {
  return {
    ...emptyLead(), lead_id: id, name: `Biz ${id}`, category: 'Cafe', area: 'katipunan',
    osm_score: '10', ...over,
  };
}

const ids = (q: ReturnType<typeof workQueue>, group: (typeof QUEUE_GROUPS)[number]) =>
  q.groups[group].map((i) => i.lead.lead_id);

test('each lead lands in the group for the action it is waiting on', () => {
  const q = workQueue([
    lead('manual', { status: 'needs_manual' }),
    lead('short', { status: 'shortlisted' }),
    lead('pickA', { status: 'verified', tier: 'A' }),
    lead('queued', { status: 'demo_queued' }),
    lead('scaf', { status: 'scaffolded', demo_slug: 'biz-scaf' }),
    lead('built', { status: 'demo_built', demo_url: 'https://b.app' }),
    lead('ready', { status: 'demo_built', demo_url: 'https://b.app', video_url: 'https://b.app/v.mp4' }),
    lead('draft', { status: 'drafted' }),
    lead('t1due', { status: 'tier1_sent', next_action_date: '2026-09-24' }),
    lead('demodue', { status: 'demo_sent', next_action_date: '2026-09-25' }),
    lead('waiting', { status: 'tier1_sent', next_action_date: '2026-10-02' }),
    lead('replied', { status: 'replied' }),
    lead('meeting', { status: 'meeting' }),
  ], { today: TODAY });

  assert.deepEqual(ids(q, 'verify'), ['manual', 'short']);
  assert.deepEqual(ids(q, 'choose'), ['pickA']);
  assert.deepEqual(ids(q, 'build'), ['queued', 'scaf']);
  assert.deepEqual(ids(q, 'record'), ['built']);
  assert.deepEqual(ids(q, 'pitch'), ['ready']);
  assert.deepEqual(ids(q, 'send'), ['draft']);
  assert.deepEqual(ids(q, 'followup'), ['t1due', 'demodue']);
  assert.deepEqual(ids(q, 'conversations'), ['waiting', 'replied', 'meeting']);
});

test('tier B verified leads are Tier-1 volume, not a demo decision', () => {
  const q = workQueue([lead('b', { status: 'verified', tier: 'B' })], { today: TODAY });
  assert.deepEqual(ids(q, 'choose'), []);
});

test('each item offers the actions that apply to it', () => {
  const q = workQueue([
    lead('pickA', { status: 'verified', tier: 'A' }),
    lead('ready', { status: 'demo_built', demo_url: 'https://b.app', video_url: 'https://b.app/v.mp4' }),
    lead('demodue', { status: 'demo_sent', next_action_date: '2026-09-20' }),
  ], { today: TODAY });
  assert.deepEqual(q.groups.choose[0]!.actions, ['queue_demo', 'nurture', 'disqualify']);
  assert.deepEqual(q.groups.pitch[0]!.actions, ['pitch_sent']);
  assert.deepEqual(q.groups.followup[0]!.actions, ['nudged', 'replied', 'lost']);
});

test('a due follow-up says who writes it', () => {
  const q = workQueue([
    lead('t1', { status: 'tier1_sent', next_action_date: '2026-09-24' }),
    lead('demo', { status: 'demo_sent', next_action_date: '2026-09-24' }),
  ], { today: TODAY });
  assert.match(q.groups.followup[0]!.note!, /npm run draft/);
  assert.match(q.groups.followup[1]!.note!, /personal/);
});

test('CRITICAL: an opted-out lead appears in no action group', () => {
  const q = workQueue(QUEUE_STATUSES.map((s, i) => lead(`x${i}`, { status: s, tier: 'A', do_not_contact: 'yes' })), { today: TODAY });
  for (const g of QUEUE_GROUPS) assert.deepEqual(q.groups[g], [], g);
  assert.equal(q.suppressed, QUEUE_STATUSES.length);
});

test('closed leads and raw sourced leads stay out; sourced is counted', () => {
  const q = workQueue([
    lead('s1', { status: 'sourced' }), lead('s2', { status: 'sourced' }),
    lead('won', { status: 'won' }), lead('lost', { status: 'lost' }),
  ], { today: TODAY });
  for (const g of QUEUE_GROUPS) assert.deepEqual(q.groups[g], [], g);
  assert.equal(q.unverified, 2);
});

test('the area filter narrows everything, counts included', () => {
  const q = workQueue([
    lead('here', { status: 'needs_manual' }),
    lead('there', { status: 'needs_manual', area: 'shaw' }),
    lead('s', { status: 'sourced', area: 'shaw' }),
  ], { today: TODAY, area: 'katipunan' });
  assert.deepEqual(ids(q, 'verify'), ['here']);
  assert.equal(q.unverified, 0);
});

test('within a group the best stage-1 score comes first', () => {
  const q = workQueue([
    lead('low', { status: 'needs_manual', osm_score: '3' }),
    lead('high', { status: 'needs_manual', osm_score: '30' }),
  ], { today: TODAY });
  assert.deepEqual(ids(q, 'verify'), ['high', 'low']);
});

const QUEUE_STATUSES = [
  'needs_manual', 'shortlisted', 'verified', 'demo_queued', 'scaffolded', 'demo_built',
  'drafted', 'tier1_sent', 'demo_sent', 'replied', 'meeting',
] as const;
