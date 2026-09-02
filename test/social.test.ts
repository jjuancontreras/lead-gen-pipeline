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
