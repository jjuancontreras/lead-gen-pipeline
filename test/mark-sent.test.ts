import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSent, sentPatch, sentRefusal, DRAFTED } from '../src/mark-sent.ts';
import { CADENCE, FINAL_TEMPLATE } from '../src/cadence.ts';
import { addDays } from '../src/dates.ts';
import { emptyLead, INACTIVE, type Lead } from '../src/lead.ts';

/** A Katipunan lead sitting in the drafted state, waiting on a human. */
function lead(over: Partial<Lead> = {}): Lead {
  return {
    ...emptyLead(),
    lead_id: 'node/1', name: 'Test Cafe', area: 'katipunan',
    email: 'hello@testcafe.ph', tier: 'B', status: DRAFTED,
    ...over,
  };
}

// ---- selection -------------------------------------------------------------

test('only drafted leads in the named area are eligible', () => {
  // Arrange
  const all = [
    lead(),
    lead({ lead_id: 'node/2', name: 'Elsewhere', area: 'maginhawa' }),
    lead({ lead_id: 'node/3', name: 'Already Sent', status: 'tier1_sent' }),
    lead({ lead_id: 'node/4', name: 'Not Drafted', status: 'verified' }),
  ];

  // Act
  const plan = planSent(all, { area: 'katipunan', all: true });

  // Assert
  assert.deepEqual(plan.chosen.map((l) => l.lead_id), ['node/1']);
});

test('a lead is nameable by lead_id or by the slug printed in the drafts index', () => {
  // Arrange
  const all = [lead(), lead({ lead_id: 'node/2', name: 'Second Place' })];

  // Act
  const byId = planSent(all, { ids: ['node/1'] });
  const bySlug = planSent(all, { ids: ['second-place'] });
  const byFilename = planSent(all, { ids: ['second-place.md'] });

  // Assert
  assert.deepEqual(byId.chosen.map((l) => l.name), ['Test Cafe']);
  assert.deepEqual(bySlug.chosen.map((l) => l.name), ['Second Place']);
  assert.deepEqual(byFilename.chosen.map((l) => l.name), ['Second Place']);
});

test('an id nobody matches is reported, not silently dropped', () => {
  const plan = planSent([lead()], { ids: ['node/1', 'ghost-cafe'] });

  assert.deepEqual(plan.chosen.map((l) => l.lead_id), ['node/1']);
  assert.deepEqual(plan.unmatched, ['ghost-cafe']);
});

test('naming the same lead twice marks it once', () => {
  const plan = planSent([lead()], { ids: ['node/1', 'test-cafe'] });

  assert.equal(plan.chosen.length, 1);
  assert.deepEqual(plan.unmatched, []);
});

test('CRITICAL: an opted-out lead is never marked as contacted, even by name', () => {
  // Arrange
  const all = [lead({ do_not_contact: 'yes' })];

  // Act
  const named = planSent(all, { ids: ['node/1'] });
  const sweep = planSent(all, { area: 'katipunan', all: true });

  // Assert
  assert.deepEqual(named.chosen, [], 'asking for it by id must not override the flag');
  assert.deepEqual(named.unmatched, ['node/1'], 'and the human is told why nothing happened');
  assert.deepEqual(sweep.chosen, []);
  assert.deepEqual(sweep.suppressed.map((l) => l.name), ['Test Cafe']);
});

test('sentRefusal: only a drafted, non-suppressed lead can be confirmed sent', () => {
  assert.equal(sentRefusal(lead()), null);
  assert.match(sentRefusal(lead({ status: 'verified' })) ?? '', /"verified", not "drafted"/);
  assert.match(sentRefusal(lead({ do_not_contact: 'yes' })) ?? '', /do_not_contact/);
});

test('omitting --area sweeps every area', () => {
  const all = [lead(), lead({ lead_id: 'node/2', area: 'maginhawa' })];

  const plan = planSent(all, { all: true });

  assert.equal(plan.chosen.length, 2);
});

// ---- the patch -------------------------------------------------------------

test('a first send stamps the clock start and schedules the first follow-up', () => {
  // Arrange
  const l = lead();

  // Act
  const patch = sentPatch(l, '2026-09-03');

  // Assert
  assert.equal(patch.status, 'tier1_sent');
  assert.equal(patch.first_contacted_at, '2026-09-03');
  assert.equal(patch.last_contacted_at, '2026-09-03');
  assert.equal(patch.next_action_date, addDays('2026-09-03', CADENCE[0]!.day));
});

test('CRITICAL: a follow-up never moves first_contacted_at forward', () => {
  // Arrange - contacted on the 3rd, follow-up sent on the 6th (day 3).
  const l = lead({ status: DRAFTED, first_contacted_at: '2026-09-03' });

  // Act
  const patch = sentPatch(l, '2026-09-06');

  // Assert
  assert.equal(patch.first_contacted_at, undefined, 'the column is left untouched');
  assert.equal(patch.last_contacted_at, '2026-09-06');
  // Measured from the original contact, so the sequence still terminates.
  assert.equal(patch.next_action_date, addDays('2026-09-03', CADENCE[1]!.day));
});

test('the sequence ends after the breakup: nurture, and nothing left to schedule', () => {
  // Arrange - the day-14 breakup going out on day 14.
  const first = '2026-09-03';
  const l = lead({ first_contacted_at: first });

  // Act
  const patch = sentPatch(l, addDays(first, CADENCE[CADENCE.length - 1]!.day));

  // Assert
  assert.equal(patch.next_action_date, '');
  assert.equal(patch.status, 'nurture');
  assert.ok(INACTIVE.has(patch.status!), 'INACTIVE is what stops the loop running forever');
  assert.equal(FINAL_TEMPLATE, 'breakup-14');
});

test('a send that lands late still lands on the next unfinished step, not a repeat', () => {
  // Arrange - the day-3 note went out a week late, on day 10.
  const first = '2026-09-03';

  // Act
  const patch = sentPatch(lead({ first_contacted_at: first }), addDays(first, 10));

  // Assert
  assert.equal(patch.next_action_date, addDays(first, 14), 'skips forward, never backward');
  assert.equal(patch.status, 'tier1_sent');
});

test('the patch touches no column outside the contact block', () => {
  const patch = sentPatch(lead(), '2026-09-03');

  assert.deepEqual(
    Object.keys(patch).sort(),
    ['first_contacted_at', 'last_contacted_at', 'next_action_date', 'status'],
  );
});
