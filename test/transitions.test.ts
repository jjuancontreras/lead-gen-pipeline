import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLead, type Lead } from '../src/lead.ts';
import { transition, ACTIONS, type TransitionResult } from '../src/transitions.ts';

const NOW = '2026-09-25';

function lead(over: Partial<Lead> = {}): Lead {
  return {
    ...emptyLead(), lead_id: 'node/1', name: 'Kuro', category: 'Cafe', area: 'katipunan',
    status: 'verified', tier: 'A', has_website: 'no', ...over,
  };
}

const patchOf = (r: TransitionResult) => {
  if ('refusal' in r) assert.fail(`refused: ${r.refusal}`);
  return r.patch;
};
const refusalOf = (r: TransitionResult) => {
  if (!('refusal' in r)) assert.fail(`expected a refusal, got ${JSON.stringify(r.patch)}`);
  return r.refusal;
};

test('queue_demo takes a verified lead into demo_queued, and unqueue puts it back', () => {
  assert.deepEqual(patchOf(transition(lead(), 'queue_demo', { now: NOW })), { status: 'demo_queued' });
  assert.deepEqual(patchOf(transition(lead({ status: 'demo_queued' }), 'unqueue', { now: NOW })), { status: 'verified' });
});

test('an action from the wrong status is refused with the reason', () => {
  assert.match(refusalOf(transition(lead({ status: 'sourced' }), 'queue_demo', { now: NOW })), /"sourced".*verified/);
  assert.match(refusalOf(transition(lead({ status: 'verified' }), 'pitch_sent', { now: NOW })), /demo_built/);
});

test('scaffolded records the slug the demo folder was created under', () => {
  assert.deepEqual(patchOf(transition(lead({ status: 'demo_queued' }), 'scaffolded', { now: NOW, slug: 'kuro' })),
    { status: 'scaffolded', demo_slug: 'kuro' });
  assert.match(refusalOf(transition(lead({ status: 'demo_queued' }), 'scaffolded', { now: NOW })), /slug/);
});

test('mark_built needs a live http(s) URL', () => {
  const l = lead({ status: 'scaffolded', demo_slug: 'kuro' });
  assert.deepEqual(patchOf(transition(l, 'mark_built', { now: NOW, url: 'https://kuro-demo.vercel.app' })),
    { status: 'demo_built', demo_url: 'https://kuro-demo.vercel.app' });
  assert.match(refusalOf(transition(l, 'mark_built', { now: NOW })), /URL/);
  assert.match(refusalOf(transition(l, 'mark_built', { now: NOW, url: 'javascript:alert(1)' })), /http/);
  assert.match(refusalOf(transition(l, 'mark_built', { now: NOW, url: 'kuro.vercel.app' })), /http/);
});

test('set_video records the hosted walkthrough link on a built demo', () => {
  const l = lead({ status: 'demo_built', demo_url: 'https://kuro.vercel.app' });
  assert.deepEqual(patchOf(transition(l, 'set_video', { now: NOW, url: 'https://kuro.vercel.app/demo/kuro-16x9.mp4' })),
    { video_url: 'https://kuro.vercel.app/demo/kuro-16x9.mp4' });
});

test('pitch_sent needs both links, then starts the 3/7/14 clock as demo_sent', () => {
  const ready = lead({ status: 'demo_built', demo_url: 'https://kuro.vercel.app', video_url: 'https://kuro.vercel.app/v.mp4' });
  assert.deepEqual(patchOf(transition(ready, 'pitch_sent', { now: NOW })), {
    status: 'demo_sent', first_contacted_at: NOW, last_contacted_at: NOW, next_action_date: '2026-09-28',
  });
  assert.match(refusalOf(transition({ ...ready, video_url: '' }, 'pitch_sent', { now: NOW })), /video/);
});

test('a pitch to a lead contacted before keeps its original first-contact date', () => {
  const ready = lead({
    status: 'demo_built', demo_url: 'https://k.app', video_url: 'https://k.app/v.mp4',
    first_contacted_at: '2026-09-01',
  });
  const p = patchOf(transition(ready, 'pitch_sent', { now: NOW }));
  assert.equal(p.first_contacted_at, undefined, 'never rewritten');
  assert.equal(p.status, 'nurture', 'the sequence from 09-01 is already over');
});

test('nudged keeps a demo lead in demo_sent and schedules the next touch', () => {
  const sent = lead({ status: 'demo_sent', first_contacted_at: '2026-09-22', next_action_date: '2026-09-25' });
  assert.deepEqual(patchOf(transition(sent, 'nudged', { now: NOW })),
    { status: 'demo_sent', last_contacted_at: NOW, next_action_date: '2026-09-29' });
});

test('outcomes: replied, meeting, won, lost, nurture, disqualify', () => {
  assert.equal(patchOf(transition(lead({ status: 'tier1_sent' }), 'replied', { now: NOW })).status, 'replied');
  assert.equal(patchOf(transition(lead({ status: 'demo_sent' }), 'replied', { now: NOW })).status, 'replied');
  assert.equal(patchOf(transition(lead({ status: 'replied' }), 'meeting', { now: NOW })).status, 'meeting');
  assert.equal(patchOf(transition(lead({ status: 'meeting' }), 'won', { now: NOW })).status, 'won');
  assert.equal(patchOf(transition(lead({ status: 'replied' }), 'lost', { now: NOW })).status, 'lost');
  assert.equal(patchOf(transition(lead({ status: 'verified' }), 'nurture', { now: NOW })).status, 'nurture');
  assert.equal(patchOf(transition(lead({ status: 'verified' }), 'disqualify', { now: NOW })).status, 'disqualified');
});

test('a reply stops the follow-up clock', () => {
  const p = patchOf(transition(lead({ status: 'tier1_sent', next_action_date: '2026-09-28' }), 'replied', { now: NOW }));
  assert.equal(p.next_action_date, '');
});

test('a closed lead cannot be moved by any action', () => {
  for (const status of ['won', 'lost', 'nurture', 'disqualified'] as const) {
    for (const action of ACTIONS) {
      assert.ok('refusal' in transition(lead({ status }), action, { now: NOW, url: 'https://x.app', slug: 'x' }),
        `${action} moved a ${status} lead`);
    }
  }
});

test('CRITICAL: an opted-out lead can be closed out but never moved toward contact', () => {
  const optedOut = { do_not_contact: 'yes' };
  for (const [status, action] of [
    ['verified', 'queue_demo'], ['demo_queued', 'scaffolded'], ['scaffolded', 'mark_built'],
    ['demo_built', 'set_video'], ['demo_built', 'pitch_sent'], ['demo_sent', 'nudged'],
  ] as const) {
    const l = lead({ status, ...optedOut, demo_url: 'https://k.app', video_url: 'https://k.app/v.mp4' });
    assert.match(refusalOf(transition(l, action, { now: NOW, url: 'https://k.app', slug: 'k' })), /do_not_contact/, action);
  }
  assert.equal(patchOf(transition(lead({ status: 'demo_sent', ...optedOut }), 'lost', { now: NOW })).status, 'lost');
  assert.equal(patchOf(transition(lead(optedOut), 'disqualify', { now: NOW })).status, 'disqualified');
});
