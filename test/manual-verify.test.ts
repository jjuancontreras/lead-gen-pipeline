import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLead, type Lead } from '../src/lead.ts';
import { loadCategories } from '../src/config.ts';
import { manualVerifyPatch, hasAnyContact, ManualAnswers, searchLinks } from '../src/manual-verify.ts';

const config = loadCategories();

function lead(over: Partial<Lead> = {}): Lead {
  return {
    ...emptyLead(), lead_id: 'node/1', name: 'Kuro', category: 'Cafe', area: 'katipunan',
    status: 'needs_manual', osm_score: '20', ...over,
  };
}

test('a social page is recorded as no website, verified by hand with high confidence', () => {
  const p = manualVerifyPatch(lead(), { website_url: 'https://www.facebook.com/kurocafe', phone: '0917 555 0101' }, config);
  assert.equal(p.has_website, 'no');
  assert.equal(p.website_kind, 'facebook');
  assert.equal(p.verify_method, 'manual');
  assert.equal(p.verify_confidence, 'high');
  assert.equal(p.phone, '0917 555 0101');
  assert.ok(p.tier, 'scored into a tier');
  assert.ok(p.status && p.status !== 'needs_manual', `status moved on: ${p.status}`);
});

test('a standalone site is recorded as a website', () => {
  const p = manualVerifyPatch(lead(), { website_url: 'https://kurocafe.ph' }, config);
  assert.equal(p.has_website, 'yes');
  assert.equal(p.website_kind, 'standalone');
});

test('blank answers leave the existing value alone', () => {
  const p = manualVerifyPatch(lead({ email: 'old@kuro.example.com' }), { instagram: '@kuro', email: '' }, config);
  assert.equal('email' in p, false);
  assert.equal(p.instagram, '@kuro');
});

test('scoring reasons are appended to the notes typed in', () => {
  const p = manualVerifyPatch(lead(), { facebook: 'kurocafe', notes: 'owner is friendly' }, config);
  assert.match(p.notes ?? '', /^owner is friendly \| /);
});

test('hasAnyContact: at least one of website or a contact channel', () => {
  assert.equal(hasAnyContact({}), false);
  assert.equal(hasAnyContact({ notes: 'closed on Mondays', rating: '4.5' }), false);
  assert.equal(hasAnyContact({ tiktok: '@kuro' }), true);
});

test('the form schema trims, and rejects a bad email or an out-of-range rating by field', () => {
  assert.deepEqual(ManualAnswers.parse({ instagram: '  @kuro ' }), { instagram: '@kuro' });
  const bad = ManualAnswers.safeParse({ email: 'not-an-email', rating: '7', review_count: 'lots' });
  assert.ok(!bad.success);
  assert.deepEqual(bad.error.issues.map((i) => i.path[0]).sort(), ['email', 'rating', 'review_count']);
  assert.ok(ManualAnswers.safeParse({ email: '', rating: '' }).success, 'blank is fine');
});

test('searchLinks prebuilds the four places to look, quoting the name for web search', () => {
  const l = searchLinks({ name: "Gerry's Grill", maps_url: '' }, 'Katipunan');
  assert.match(l.maps, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Gerry/);
  assert.equal(l.web, 'https://www.google.com/search?q=%22Gerry\'s%20Grill%22%20Katipunan');
  assert.match(l.facebook, /facebook\.com\/search\/top\?q=/);
  assert.match(l.instagram, /instagram\.com\/explore\/search\/keyword\/\?q=Gerry/);
  assert.equal(searchLinks({ name: 'X', maps_url: 'https://maps.example/x' }, 'Q').maps, 'https://maps.example/x');
});
