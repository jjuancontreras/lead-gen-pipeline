import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage2 } from '../src/score.ts';
import { loadCategories } from '../src/config.ts';
import { emptyLead, type Lead } from '../src/lead.ts';

const config = loadCategories();

/** A healthy Katipunan cafe: good reviews, plenty of photos, reachable. */
function lead(over: Partial<Lead> = {}): Lead {
  return {
    ...emptyLead(),
    name: 'Test Cafe', chain_locations: '1',
    rating: '4.5', review_count: '180', ig_followers: '2400', photo_count: '12',
    email: 'hello@testcafe.ph',
    ...over,
  };
}

test('CRITICAL: a business whose only site is a Facebook page scores A', () => {
  // The single assertion the whole filter exists for. If this ever regresses
  // to "disqualified", the pipeline rejects its best prospects.
  const r = stage2(lead({ website_url: 'https://www.facebook.com/testcafe' }), config);
  assert.equal(r.status, 'verified', `got status ${r.status}: ${r.reasons.join('; ')}`);
  assert.equal(r.tier, 'A', `got tier ${r.tier} (score ${r.score}): ${r.reasons.join('; ')}`);
});

test('the same holds for Instagram, TikTok and Linktree', () => {
  for (const url of [
    'https://instagram.com/testcafe',
    'https://www.tiktok.com/@testcafe',
    'https://linktr.ee/testcafe',
    'https://food.grab.com/ph/en/restaurant/testcafe',
  ]) {
    const r = stage2(lead({ website_url: url }), config);
    assert.notEqual(r.status, 'disqualified', `${url} was disqualified`);
  }
});

test('a real standalone website disqualifies - nothing to sell', () => {
  const r = stage2(lead({ website_url: 'https://testcafe.com.ph' }), config);
  assert.equal(r.status, 'disqualified');
  assert.equal(r.tier, '');
});

test('a free-host site disqualifies but is flagged as an upsell', () => {
  const r = stage2(lead({ website_url: 'https://testcafe.wixsite.com/home' }), config);
  assert.equal(r.status, 'disqualified');
  assert.match(r.reasons.join(' '), /free host|upsell/i);
});

test('the ceiling rejects businesses that are too big', () => {
  assert.equal(stage2(lead({ website_url: 'facebook.com/x', review_count: '5000' }), config).status, 'disqualified');
  assert.equal(stage2(lead({ website_url: 'facebook.com/x', ig_followers: '90000' }), config).status, 'disqualified');
});

test('the floor parks small businesses as nurture, never disqualified', () => {
  for (const over of [{ review_count: '4' }, { photo_count: '2' }, { ig_followers: '50' }]) {
    const r = stage2(lead({ website_url: 'facebook.com/x', ...over }), config);
    assert.equal(r.status, 'nurture', JSON.stringify(over));
    assert.notEqual(r.status, 'disqualified', 'below-floor leads must be revisitable');
  }
});

test('2-4 branches is a bonus, not a penalty', () => {
  const one = stage2(lead({ website_url: 'facebook.com/x', chain_locations: '1' }), config);
  const three = stage2(lead({ website_url: 'facebook.com/x', chain_locations: '3' }), config);
  assert.ok(three.score > one.score, 'multi-branch SME should score higher');
});

test('contact channel is weighted in priority order: email > phone > social', () => {
  const base = { website_url: 'facebook.com/x', email: '', phone: '', instagram: '' };
  const email = stage2(lead({ ...base, email: 'a@b.ph' }), config).score;
  const phone = stage2(lead({ ...base, phone: '0917' }), config).score;
  const social = stage2(lead({ ...base, instagram: '@x' }), config).score;
  const none = stage2(lead(base), config).score;
  assert.ok(email > phone && phone > social && social > none,
    `expected email>phone>social>none, got ${email}>${phone}>${social}>${none}`);
});

test('no web presence at all still qualifies, just lower than social-only', () => {
  const nothing = stage2(lead({ website_url: '' }), config);
  const social = stage2(lead({ website_url: 'facebook.com/x' }), config);
  assert.notEqual(nothing.status, 'disqualified');
  assert.ok(social.score > nothing.score, 'social-only should outrank no presence');
});
