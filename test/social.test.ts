import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractHandles, normalizeHandle, isPlausibleBusinessEmail, contactPatch,
} from '../src/social.ts';

// ---- normalizeHandle: the happy path ---------------------------------------

test('instagram URLs normalize to @handle', () => {
  const cases = [
    'https://www.instagram.com/kurocafe',
    'https://instagram.com/kurocafe/',
    'http://www.instagram.com/kurocafe?hl=en',
    'instagram.com/kurocafe/',
    'https://www.instagram.com/KuroCafe/',
    '@kurocafe',
    'kurocafe',
  ];
  for (const c of cases) {
    assert.equal(normalizeHandle('instagram', c), '@kurocafe', c);
  }
});

test('tiktok URLs normalize to @handle', () => {
  for (const c of ['https://www.tiktok.com/@kurocafe', 'tiktok.com/@kurocafe/', 'https://www.tiktok.com/@KuroCafe?lang=en']) {
    assert.equal(normalizeHandle('tiktok', c), '@kurocafe', c);
  }
});

test('facebook URLs normalize to the page slug, not @handle', () => {
  for (const c of ['https://www.facebook.com/kurocafeqc', 'https://m.facebook.com/kurocafeqc/', 'https://web.facebook.com/kurocafeqc?ref=page_internal', 'facebook.com/kurocafeqc/posts/12345']) {
    assert.equal(normalizeHandle('facebook', c), 'kurocafeqc', c);
  }
});

test('query strings, trailing slashes and www are stripped', () => {
  assert.equal(normalizeHandle('instagram', 'https://www.instagram.com/kurocafe/?igshid=abc123'), '@kurocafe');
  assert.equal(normalizeHandle('facebook', 'https://www.facebook.com/kurocafeqc/?rdid=xyz'), 'kurocafeqc');
  assert.equal(normalizeHandle('tiktok', 'https://www.tiktok.com/@kurocafe/?is_from_webapp=1'), '@kurocafe');
});

// ---- normalizeHandle: the part that matters --------------------------------

test('CRITICAL: instagram non-business paths are not handles', () => {
  const poison = [
    'https://www.instagram.com/p/CxYz123abc/',
    'https://instagram.com/reel/CxYz123abc/',
    'https://www.instagram.com/reels/CxYz123abc/',
    'https://www.instagram.com/explore/tags/coffee/',
    'https://www.instagram.com/accounts/login/?next=%2Fkurocafe%2F',
    'https://www.instagram.com/accounts/emailsignup/',
    'https://www.instagram.com/tv/CxYz123abc/',
    'https://www.instagram.com/stories/kurocafe/12345/',
    'https://www.instagram.com/legal/terms/',
    'https://www.instagram.com/about/us/',
    'https://help.instagram.com/',
    'https://www.instagram.com/',
    'https://www.instagram.com',
  ];
  for (const u of poison) {
    assert.equal(normalizeHandle('instagram', u), '', `must reject: ${u}`);
  }
});

test('CRITICAL: facebook share buttons and pixels are not handles', () => {
  // These appear on nearly every SME page with a marketing plugin. Writing any
  // of them to the facebook column would poison the entire sheet.
  const poison = [
    'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fkuro.ph',
    'https://www.facebook.com/sharer.php?u=https://kuro.ph',
    'https://www.facebook.com/share.php?u=https://kuro.ph',
    'https://www.facebook.com/tr?id=1234567890&ev=PageView&noscript=1',
    'https://www.facebook.com/plugins/page.php?href=x&tabs=timeline',
    'https://www.facebook.com/plugins/like.php',
    'https://www.facebook.com/login.php?next=abc',
    'https://www.facebook.com/login',
    'https://www.facebook.com/privacy/policy/',
    'https://www.facebook.com/policies/cookies/',
    'https://www.facebook.com/dialog/share?app_id=1',
    'https://staticxx.facebook.com/x/connect/xd_arbiter/?version=46',
    'https://www.facebook.com/groups/manilafoodies',
    'https://www.facebook.com/events/1234567890',
    'https://www.facebook.com/watch/?v=123',
    'https://www.facebook.com/help/contact/',
    'https://www.facebook.com/',
    'https://www.facebook.com',
  ];
  for (const u of poison) {
    assert.equal(normalizeHandle('facebook', u), '', `must reject: ${u}`);
  }
});

test('CRITICAL: tiktok content paths are not handles', () => {
  const poison = [
    'https://www.tiktok.com/tag/manilafood',
    'https://www.tiktok.com/music/original-sound-123',
    'https://www.tiktok.com/video/7123456789',
    'https://www.tiktok.com/@kurocafe/video/7123456789'.replace('@kurocafe', 'discover'),
    'https://www.tiktok.com/foryou',
    'https://www.tiktok.com/legal/terms-of-service',
    'https://www.tiktok.com/embed/7123456789',
    // No leading @ means it is not an account URL at all.
    'https://www.tiktok.com/kurocafe',
    'https://www.tiktok.com/',
  ];
  for (const u of poison) {
    assert.equal(normalizeHandle('tiktok', u), '', `must reject: ${u}`);
  }
});

test('lookalike hosts do not yield handles', () => {
  // normalizeHandle only strips a host it recognises; an unrelated host stays
  // in the path and fails the shape check rather than becoming a handle.
  assert.equal(normalizeHandle('facebook', 'https://notfacebook.com/kurocafe'), '');
  assert.equal(normalizeHandle('instagram', 'https://facebook.com.evil.ph/kurocafe'), '');
});

test('handles that cannot exist on the platform are rejected', () => {
  // Facebook usernames are at least 5 characters.
  assert.equal(normalizeHandle('facebook', 'https://www.facebook.com/kuro'), '');
  assert.equal(normalizeHandle('instagram', 'https://www.instagram.com/' + 'a'.repeat(40)), '');
  // No platform allows a space in an account name.
  assert.equal(normalizeHandle('instagram', 'https://www.instagram.com/kuro cafe'), '');
  assert.equal(normalizeHandle('tiktok', 'https://www.tiktok.com/@x'), '');
});

test('legacy facebook identities survive: they ARE the business', () => {
  // Many PH pages never claimed a vanity URL. Rejecting these loses real leads.
  assert.equal(
    normalizeHandle('facebook', 'https://www.facebook.com/profile.php?id=61550123456789'),
    'profile.php?id=61550123456789',
  );
  assert.equal(
    normalizeHandle('facebook', 'https://www.facebook.com/profile.php?id=61550123456789&sk=about'),
    'profile.php?id=61550123456789',
  );
  assert.equal(
    normalizeHandle('facebook', 'https://www.facebook.com/pages/Kuro-Cafe/123456789012345'),
    'pages/kuro-cafe/123456789012345',
  );
  // /pg/<slug>/about is just the page again.
  assert.equal(normalizeHandle('facebook', 'https://www.facebook.com/pg/kurocafeqc/about/'), 'kurocafeqc');
});

test('facebook directory browse pages are not businesses', () => {
  assert.equal(normalizeHandle('facebook', 'https://www.facebook.com/pages/category/Restaurant/'), '');
  assert.equal(normalizeHandle('facebook', 'https://www.facebook.com/pages/category/Coffee-Shop/12345'), '');
  assert.equal(normalizeHandle('facebook', 'https://www.facebook.com/profile.php'), '');
  assert.equal(normalizeHandle('facebook', 'https://www.facebook.com/profile.php?ref=abc'), '');
});

test('empty and junk input never invents a handle', () => {
  for (const kind of ['instagram', 'facebook', 'tiktok'] as const) {
    assert.equal(normalizeHandle(kind, ''), '');
    assert.equal(normalizeHandle(kind, '   '), '');
    assert.equal(normalizeHandle(kind, '///'), '');
  }
});

test('trailing sentence punctuation is not part of the handle', () => {
  assert.equal(normalizeHandle('instagram', 'Follow instagram.com/kurocafe.'.slice(7)), '@kurocafe');
});

// ---- isPlausibleBusinessEmail ---------------------------------------------

test('real business addresses pass', () => {
  for (const e of ['hello@kuro.ph', 'kurocafe.qc@gmail.com', 'info@kuro-cafe.com.ph', 'orders+catering@kuro.ph']) {
    assert.equal(isPlausibleBusinessEmail(e), true, e);
  }
});

test('CRITICAL: asset filenames caught by the regex are rejected', () => {
  for (const e of ['logo@2x.png', 'sprite@3x.jpg', 'icon@2x.webp', 'bundle@abc.js', 'theme@v1.css']) {
    assert.equal(isPlausibleBusinessEmail(e), false, e);
  }
});

test('CRITICAL: vendor and template addresses are rejected', () => {
  const junk = [
    'abc123@sentry.io',
    '4f8e1c2b3a4d5e6f7a8b9c0d1e2f3a4b@o123456.ingest.sentry.io',
    'noreply@sentry.wixpress.com',
    'support@wixpress.com',
    'hello@example.com',
    'you@example.org',
    'test@test.com',
    'youremail@domain.com',
    'email@yourdomain.com',
    'noreply@kuro.ph',
    'no-reply@kuro.ph',
    'donotreply@kuro.ph',
  ];
  for (const e of junk) {
    assert.equal(isPlausibleBusinessEmail(e), false, e);
  }
});

test('malformed strings are rejected', () => {
  for (const e of ['', 'not an email', 'a@b', '@kuro.ph', 'hello@', 'hello@.ph', 'hello@kuro.']) {
    assert.equal(isPlausibleBusinessEmail(e), false, JSON.stringify(e));
  }
});

// ---- extractHandles --------------------------------------------------------

const REALISTIC_PAGE_HTML = `
<html><head>
<script>!function(f,b,e,v,n,t,s){...}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');</script>
<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=1234567890&amp;ev=PageView&amp;noscript=1"/></noscript>
</head><body>
<a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fkuro.ph%2Fmenu">Share</a>
<a href="https://www.instagram.com/p/CxYz123abc/">See our latest post</a>
<footer>
  <a href="https://www.instagram.com/kurocafeqc/">Instagram</a>
  <a href="https://www.facebook.com/kurocafeqc">Facebook</a>
  <a href="https://www.tiktok.com/@kurocafeqc">TikTok</a>
  <a href="mailto:hello@kuro.ph">hello@kuro.ph</a>
</footer>
<script>Sentry.init({dsn:"https://4f8e1c2b3a4d5e6f7a8b9c0d1e2f3a4b@o123456.ingest.sentry.io/999"});</script>
<img src="/assets/logo@2x.png">
</body></html>`;

test('a realistic page yields the business, not the plugins', () => {
  const got = extractHandles('Kuro Cafe - Katipunan\nhello@kuro.ph', REALISTIC_PAGE_HTML);
  assert.deepEqual(got, {
    instagram: '@kurocafeqc',
    facebook: 'kurocafeqc',
    tiktok: '@kurocafeqc',
    email: 'hello@kuro.ph',
  });
});

test('a page whose ONLY facebook link is a pixel yields no facebook handle', () => {
  const html = `<noscript><img src="https://www.facebook.com/tr?id=999&ev=PageView"/></noscript>
    <a href="https://www.facebook.com/sharer/sharer.php?u=https://kuro.ph">Share</a>`;
  const got = extractHandles('', html);
  assert.equal(got.facebook, undefined, 'a pixel and a share button are not a page');
});

test('a facebook page plugin embed still yields the real page', () => {
  // The plugin URL wraps the business page in a percent-encoded query string.
  const html = '<iframe src="https://www.facebook.com/plugins/page.php?href=https%3A%2F%2Fwww.facebook.com%2Fkurocafeqc&tabs=timeline"></iframe>';
  assert.equal(extractHandles('', html).facebook, 'kurocafeqc');
});

test('JSON-escaped links inside inline scripts are found', () => {
  const html = '<script>window.__DATA__={"ig":"https:\\/\\/www.instagram.com\\/kurocafeqc\\/"}</script>';
  assert.equal(extractHandles('', html).instagram, '@kurocafeqc');
});

test('the most-repeated handle wins over a one-off mention', () => {
  // The business links itself in the header and the footer; a supplier or a
  // "web design by" credit gets linked once.
  const html = `
    <header><a href="https://instagram.com/kurocafeqc">us</a></header>
    <main><a href="https://instagram.com/somesupplier">our beans</a></main>
    <footer><a href="https://instagram.com/kurocafeqc">us again</a></footer>`;
  assert.equal(extractHandles('', html).instagram, '@kurocafeqc');
});

test('extraction works from plain text alone and from html alone', () => {
  const text = 'Find us on instagram.com/kurocafeqc or email hello@kuro.ph';
  assert.equal(extractHandles(text, '').instagram, '@kurocafeqc');
  assert.equal(extractHandles(text, '').email, 'hello@kuro.ph');
  assert.deepEqual(extractHandles('', ''), {});
});

test('a page with no contacts returns no keys rather than empty strings', () => {
  const got = extractHandles('Just a menu.', '<html><body>Just a menu.</body></html>');
  assert.deepEqual(got, {});
  assert.equal(Object.keys(got).length, 0);
});

// ---- contactPatch ----------------------------------------------------------

test('contactPatch never overwrites an existing value', () => {
  const patch = contactPatch(
    { email: 'owner@kuro.ph', instagram: '', facebook: '', tiktok: '' },
    { email: 'scraped@kuro.ph', instagram: '@kurocafeqc' },
  );
  assert.deepEqual(patch, { instagram: '@kurocafeqc' });
});

test('contactPatch never writes an empty value over anything', () => {
  assert.deepEqual(contactPatch({ instagram: '@existing' }, {}), {});
  assert.deepEqual(contactPatch({}, { facebook: '' }), {});
  assert.deepEqual(contactPatch({ email: '   ' }, { email: 'hello@kuro.ph' }), { email: 'hello@kuro.ph' });
});

// ============================================================================
// The enrich stage's pure half. It lives here because every rule below is a
// rule about which extracted contact is safe to WRITE - the same question the
// rest of this file asks, one layer up.
// ============================================================================

import {
  planSources, needsEnrichment, looksLikeThisBusiness, trustedHandles,
  mergeFound, missingChannels, detectWall, coverageSummary, emptyGains,
  IDENTITY_MIN, MIN_PACE_MS, type EnrichReport,
} from '../src/stages/enrich.ts';
import { emptyLead, type Lead } from '../src/lead.ts';

const mk = (over: Partial<Lead> = {}): Lead => ({
  ...emptyLead(), lead_id: 'node/1', name: 'Kuro Cafe', area: 'katipunan',
  status: 'verified', ...over,
});

// ---- who the stage picks up ------------------------------------------------

test('enrich takes verified leads in this area that have no email', () => {
  assert.equal(needsEnrichment(mk(), 'katipunan'), true);
  assert.equal(needsEnrichment(mk({ email: 'hi@kuro.ph' }), 'katipunan'), false,
    'an email is the thing we came for - having one means there is nothing to do');
  assert.equal(needsEnrichment(mk({ status: 'sourced' }), 'katipunan'), false);
  assert.equal(needsEnrichment(mk({ status: 'won' }), 'katipunan'), false);
  assert.equal(needsEnrichment(mk(), 'maginhawa'), false, 'another area is another run');
  assert.equal(needsEnrichment(mk({ email: '   ' }), 'katipunan'), true, 'whitespace is not an email');
});

// ---- source order ----------------------------------------------------------

test('the business own social page is visited before any search', () => {
  const sources = planSources(mk({ website_url: 'https://www.facebook.com/kurocafeqc' }), 'Katipunan, QC');
  assert.equal(sources.length, 2);
  assert.equal(sources[0]!.kind, 'own');
  assert.equal(sources[0]!.url, 'https://www.facebook.com/kurocafeqc');
  assert.equal(sources[1]!.kind, 'search');
});

test('a standalone site is not an own-source - the extractor is for socials', () => {
  // A real website already means this lead is not a prospect; it is also not
  // where this stage looks, so only the search remains.
  const sources = planSources(mk({ website_url: 'https://kurocafe.ph' }), 'Katipunan, QC');
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.kind, 'search');
});

test('a lead with no web presence at all still gets searched', () => {
  const sources = planSources(mk(), 'Katipunan, QC');
  assert.deepEqual(sources.map((s) => s.kind), ['search']);
});

test('the search query quotes the name and carries the area', () => {
  const url = planSources(mk(), 'Katipunan, QC')[0]!.url;
  const q = decodeURIComponent(url.slice(url.indexOf('?q=') + 3));
  assert.equal(q, '"Kuro Cafe" Katipunan, QC instagram');
});

test('a protocol-less website_url is still loadable', () => {
  const sources = planSources(mk({ website_url: 'facebook.com/kurocafeqc' }), 'Katipunan, QC');
  assert.equal(sources[0]!.url, 'https://facebook.com/kurocafeqc');
});

// ---- trusting a shared page ------------------------------------------------

test('CRITICAL: a search page handle must look like this business', () => {
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'instagram', '@kurocafe'), true);
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'instagram', '@kuro.cafe'), true);
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'instagram', '@kuro_cafe'), true);
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'facebook', 'kurocafeqc'), true);
  // The handles of every OTHER business the results page happened to list.
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'instagram', '@starbucksph'), false);
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'facebook', 'jollibeephilippines'), false);
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'instagram', '@foodpanda.ph'), false);
});

test('an address identifies the business by its local part or its domain', () => {
  // Both halves of how Philippine SMEs actually do email.
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'email', 'kurocafe@gmail.com'), true);
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'email', 'hello@kurocafe.ph'), true);
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'email', 'hello@kurocafe.com.ph'), true,
    'a public suffix is not the business name');
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'email', 'press@zomato.com'), false);
  assert.equal(looksLikeThisBusiness('Kuro Cafe', 'email', 'hello@gmail.com'), false);
});

test('trustedHandles drops everything that failed the identity check', () => {
  const kept = trustedHandles('Kuro Cafe', {
    instagram: '@kurocafe', facebook: 'jollibeephilippines', email: 'hello@kurocafe.ph',
  });
  assert.deepEqual(kept, { email: 'hello@kurocafe.ph', instagram: '@kurocafe' });
});

test('the identity threshold is a real threshold, not zero', () => {
  assert.ok(IDENTITY_MIN > 0 && IDENTITY_MIN <= 1);
  assert.ok(MIN_PACE_MS >= 8000, 'social platforms punish bursts');
});

// ---- merging across sources ------------------------------------------------

test('the earlier source wins every field it filled', () => {
  const merged = mergeFound({ instagram: '@fromtheirpage' }, { instagram: '@fromsearch', facebook: 'kurocafeqc' });
  assert.deepEqual(merged, { instagram: '@fromtheirpage', facebook: 'kurocafeqc' });
});

test('merging never introduces an empty value', () => {
  assert.deepEqual(mergeFound({}, { instagram: '' }), {});
  assert.deepEqual(mergeFound({ email: 'a@kuro.ph' }, {}), { email: 'a@kuro.ph' });
});

test('missingChannels counts what is on the lead as well as what was found', () => {
  const lead = mk({ facebook: 'kurocafeqc' });
  assert.deepEqual(missingChannels(lead, {}), ['email', 'instagram', 'tiktok']);
  assert.deepEqual(missingChannels(lead, { email: 'a@kuro.ph', instagram: '@k', tiktok: '@k' }), []);
});

// ---- walls -----------------------------------------------------------------

test('CRITICAL: login and consent walls are detected, not extracted from', () => {
  assert.equal(detectWall('https://www.instagram.com/accounts/login/?next=%2Fkurocafe%2F', ''), 'login');
  assert.equal(detectWall('https://www.facebook.com/login.php?next=x', ''), 'login');
  assert.equal(detectWall('https://consent.google.com/m?continue=x', ''), 'consent');
  assert.equal(detectWall('https://www.google.com/sorry/index?q=x', ''), 'consent');
  assert.equal(detectWall('https://www.instagram.com/kurocafe/', 'Log in to see photos and videos from friends'), 'login');
  assert.equal(detectWall('https://www.facebook.com/kurocafeqc', 'See more of Kuro Cafe on Facebook\nLog In'), 'login');
  assert.equal(detectWall('https://www.instagram.com/kurocafe/', "You're temporarily blocked"), 'blocked');
  assert.equal(detectWall('https://www.facebook.com/kurocafeqc', "This content isn't available right now"), 'blocked');
});

test('an ordinary page is not a wall', () => {
  const text = 'Kuro Cafe\nKatipunan, Quezon City\nOpen 8am-10pm\nEmail hello@kurocafe.ph';
  assert.equal(detectWall('https://www.facebook.com/kurocafeqc', text), null);
  assert.equal(detectWall('https://html.duckduckgo.com/html/?q=x', 'Results for Kuro Cafe'), null);
});

test('a footer sign-in link on a readable page is not a wall', () => {
  // Only the top of the page counts: otherwise every page with a footer
  // "Log in to continue" link would be handed off as blocked.
  const body = 'Kuro Cafe\n' + 'Our story. '.repeat(300) + '\nLog in to continue';
  assert.equal(detectWall('https://www.facebook.com/kurocafeqc', body), null);
});

// ---- the summary the brief prints ------------------------------------------

test('the summary reports coverage gained per channel', () => {
  const report: EnrichReport = {
    attempted: 5, enriched: 3, gained: { ...emptyGains(), email: 2, instagram: 3 },
    fetches: 7, budgetExhausted: false, walled: 1, handoff: [],
  };
  const s = coverageSummary(report);
  assert.match(s, /3\/5/);
  assert.match(s, /email \+2/);
  assert.match(s, /instagram \+3/);
  assert.match(s, /facebook \+0/);
  assert.match(s, /tiktok \+0/);
  assert.match(s, /1 walled/);
});

test('the summary says so when the fetch cap stopped the run', () => {
  const report: EnrichReport = {
    attempted: 2, enriched: 0, gained: emptyGains(),
    fetches: 60, budgetExhausted: true, walled: 0, handoff: [],
  };
  assert.match(coverageSummary(report), /fetch cap/);
});
