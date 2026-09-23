import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateFor } from '../src/outreach-policy.ts';
import { templateForChannel } from '../src/outreach.ts';
import { emptyLead, type Lead } from '../src/lead.ts';

const lead = (over: Partial<Lead> = {}): Lead => ({
  ...emptyLead(),
  lead_id: 'node/1', name: 'Test Cafe', area: 'katipunan',
  email: 'hello@testcafe.ph', status: 'verified', tier: 'B',
  ...over,
});

test('templateFor: a lead nobody has contacted gets the opener for its channel', () => {
  for (const channel of ['email', 'instagram', 'facebook'] as const) {
    assert.equal(templateFor(lead(), channel, '2026-09-23'), templateForChannel(channel));
  }
});

test('templateFor: a contacted lead gets the follow-up step its first contact has earned', () => {
  const sent = (first: string) => lead({ status: 'tier1_sent', first_contacted_at: first });
  assert.equal(templateFor(sent('2026-09-20'), 'email', '2026-09-23'), 'follow-up-3');
  assert.equal(templateFor(sent('2026-09-16'), 'email', '2026-09-23'), 'follow-up-7');
  assert.equal(templateFor(sent('2026-09-09'), 'email', '2026-09-23'), 'breakup-14');
});
