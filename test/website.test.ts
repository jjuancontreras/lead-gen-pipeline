import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWebsite, isHighIntent } from '../src/website.ts';

test('a real separate site is standalone', () => {
  for (const u of ['https://kuro.ph', 'http://www.somecafe.com.ph', 'somecafe.com/menu']) {
    const v = classifyWebsite(u);
    assert.equal(v.kind, 'standalone', u);
    assert.equal(v.isStandalone, true, u);
  }
});

test('CORE RULE: social pages are NOT websites', () => {
  const cases: [string, string][] = [
    ['https://www.facebook.com/kurocafe', 'facebook'],
    ['https://m.facebook.com/kurocafe', 'facebook'],
    ['https://web.facebook.com/kurocafe', 'facebook'],
    ['fb.me/kurocafe', 'facebook'],
    ['https://instagram.com/kurocafe', 'instagram'],
    ['https://www.tiktok.com/@kurocafe', 'tiktok'],
    ['https://linktr.ee/kurocafe', 'linktree'],
    ['https://beacons.ai/kurocafe', 'linktree'],
    ['https://food.grab.com/ph/en/restaurant/kuro', 'delivery_app'],
    ['https://www.foodpanda.ph/restaurant/abc/kuro', 'delivery_app'],
  ];
  for (const [url, kind] of cases) {
    const v = classifyWebsite(url);
    assert.equal(v.kind, kind, url);
    assert.equal(v.isStandalone, false, `${url} must not count as a website`);
  }
});

test('social-only businesses are high intent - the best prospects', () => {
  for (const u of ['facebook.com/x', 'instagram.com/x', 'linktr.ee/x', 'tiktok.com/@x']) {
    assert.equal(isHighIntent(classifyWebsite(u).kind), true, u);
  }
  assert.equal(isHighIntent(classifyWebsite('https://realsite.ph').kind), false);
});

test('free-host sites are real sites, flagged as an upsell', () => {
  const v = classifyWebsite('https://kurocafe.wixsite.com/home');
  assert.equal(v.kind, 'free_host');
  assert.equal(v.isStandalone, true, 'a wix site is still a site');
  assert.equal(v.isFreeHost, true);
});

test('a Google Business profile is not a website', () => {
  assert.equal(classifyWebsite('https://kuro.business.site').isStandalone, false);
  assert.equal(classifyWebsite('https://maps.app.goo.gl/abc').isStandalone, false);
});

test('empty and unparseable input never claims a site exists', () => {
  for (const u of ['', '   ', null, undefined, 'not a url at all!!']) {
    const v = classifyWebsite(u as string);
    assert.equal(v.isStandalone, false, `input: ${JSON.stringify(u)}`);
  }
});

test('REGRESSION: messaging/marketplace hosts missing from social-domains.json (QA HIGH #1)', () => {
  // These were classifying as "standalone" and terminally disqualifying a
  // business whose only web presence is one of them - exactly the
  // highest-value prospect class the pipeline exists to find.
  const cases: [string, string][] = [
    ['https://m.me/mybakery', 'facebook'],
    ['https://messenger.com/t/x', 'facebook'],
    ['https://fb.watch/abc', 'facebook'],
    ['https://g.page/mybakery', 'marketplace'],
    ['https://shopee.com.ph/shop/x', 'delivery_app'],
    ['https://linkedin.com/company/x', 'marketplace'],
  ];
  for (const [url, kind] of cases) {
    const v = classifyWebsite(url);
    assert.equal(v.kind, kind, url);
    assert.equal(v.isStandalone, false, `${url} must not disqualify`);
  }
});

test('a lookalike domain does not match by substring', () => {
  // "notfacebook.com" and "facebook.com.evil.ph" must not classify as facebook.
  assert.equal(classifyWebsite('https://notfacebook.com').kind, 'standalone');
  assert.equal(classifyWebsite('https://facebook.com.evil.ph').kind, 'standalone');
});
