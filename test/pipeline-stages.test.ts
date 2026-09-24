/**
 * Unit tests for the find and site stages, and the find -> site handoff.
 * The video and email stages have their own files: one needs a browser, the
 * other the mail gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HtmlValidate } from 'html-validate';
import { emptyLead, type Lead } from '../src/lead.ts';
import { findStage, findRefusal, demoSlug } from '../src/pipeline/stages/find.ts';
import { siteStage } from '../src/pipeline/stages/site.ts';
import { renderSiteHtml, formatCuisine, hueFor, esc } from '../src/pipeline/site-html.ts';
import { FoundLead, SiteArtifact } from '../src/pipeline/schemas.ts';
import { NO_TRANSPORT } from '../src/pipeline/mailer.ts';
import { createLogger } from '../src/log.ts';
import type { StageContext } from '../src/pipeline/stage.ts';

function lead(over: Partial<Lead> = {}): Lead {
  return {
    ...emptyLead(),
    lead_id: 'node/42', name: 'Kapihan sa Kanto', category: 'Cafe', area: 'katipunan',
    has_website: 'no', website_kind: 'instagram', status: 'verified', tier: 'A',
    phone: '+63 917 555 0101', email: 'hello@kapihan.example.com', instagram: '@kapihan',
    cuisine: 'coffee_shop;filipino', lat: '14.6392', lng: '121.0754',
    ...over,
  };
}

function ctx(over: Partial<StageContext> = {}): StageContext {
  return {
    dataDir: mkdtempSync(join(tmpdir(), 'pl-stage-')),
    publicBaseUrl: 'http://localhost:3008',
    videoMs: 5000,
    sendEmails: false,
    mailer: NO_TRANSPORT,
    senderName: 'Jfer Contreras',
    senderEmail: 'sender@example.com',
    areaLabel: (a) => (a === 'katipunan' ? 'Katipunan, Quezon City' : a),
    log: createLogger({ format: 'json', level: 'error', sink: () => {} }),
    ...over,
  };
}

// ---- find -------------------------------------------------------------------

test('find passes a verified business with no website and validates the handoff', async () => {
  const out = await findStage.run({ lead: lead() }, ctx());
  assert.doesNotThrow(() => FoundLead.parse(out));
  assert.equal(out.name, 'Kapihan sa Kanto');
  assert.equal(out.areaLabel, 'Katipunan, Quezon City');
  assert.equal(out.slug, 'kapihan-sa-kanto-node-42');
});

test('CRITICAL: find refuses an opted-out business', async () => {
  await assert.rejects(findStage.run({ lead: lead({ do_not_contact: 'yes' }) }, ctx()), /do_not_contact/);
});

test('find refuses a business that already has a website', () => {
  assert.match(findRefusal(lead({ has_website: 'yes', website_url: 'https://x.ph' }))!, /already has a website/);
});

test('find refuses an unverified or closed-out lead', () => {
  assert.match(findRefusal(lead({ has_website: 'unknown' }))!, /not verified/);
  assert.match(findRefusal(lead({ status: 'lost' }))!, /closed out/);
  assert.match(findRefusal(lead({ category: '  ' }))!, /category/);
});

test('two businesses with one name get different slugs', () => {
  assert.notEqual(demoSlug({ name: 'Kuro', lead_id: 'node/1' }), demoSlug({ name: 'Kuro', lead_id: 'node/2' }));
});

// ---- site -------------------------------------------------------------------

async function site(over: Partial<Lead> = {}) {
  const c = ctx();
  const found = await findStage.run({ lead: lead(over) }, c);
  const out = await siteStage.run({ lead: lead(over), found }, c);
  return { out, html: readFileSync(out.indexPath, 'utf8') };
}

test('site writes an index.html and a link under the public base URL', async () => {
  const { out } = await site();
  assert.doesNotThrow(() => SiteArtifact.parse(out));
  assert.equal(out.url, 'http://localhost:3008/sites/kapihan-sa-kanto-node-42/');
  assert.equal(siteStage.isIntact(out), true);
});

test('the site is valid HTML', async () => {
  const { html } = await site();
  const report = await new HtmlValidate({ extends: ['html-validate:recommended'] }).validateString(html);
  const problems = report.results.flatMap((r) => r.messages.map((m) => `${m.ruleId}: ${m.message} (line ${m.line})`));
  assert.deepEqual(problems, []);
});

test('the site is responsive: viewport meta and breakpoints', async () => {
  const { html } = await site();
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /@media \(min-width: 48rem\)/);
  assert.match(html, /@media \(max-width: 30rem\)/);
});

test('the site shows the real business details, and a tel: link for the phone', async () => {
  const { html } = await site();
  for (const needle of ['Kapihan sa Kanto', 'Katipunan, Quezon City', 'Cafe', 'Coffee shop · Filipino',
    'tel:+639175550101', 'mailto:hello@kapihan.example.com', 'https://www.instagram.com/kapihan/']) {
    assert.ok(html.includes(needle), `missing ${needle}`);
  }
});

test('the site invents nothing: no phone on record means no phone on the page', async () => {
  const { html } = await site({ phone: '', email: '', instagram: '' });
  assert.ok(!html.includes('tel:'));
  assert.ok(!html.includes('mailto:'));
  assert.match(html, /Get directions|Open in Google Maps/);
});

test('CRITICAL: a hostile business name is escaped, not rendered as markup', async () => {
  const { html } = await site({ name: 'Evil <script>alert(1)</script> "Cafe"' });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('the about line reads as a sentence, with the right article', async () => {
  assert.match((await site()).html, /Kapihan sa Kanto is a cafe in Katipunan, Quezon City\./);
  assert.match((await site({ category: 'Optical' })).html, /is an optical in/);
});

test('the footer discloses that the page is a demo from public listings', async () => {
  const { html } = await site();
  assert.match(html, /demo website prepared by Jfer Contreras/);
  assert.match(html, /not yet been confirmed/);
});

test('every major section is marked for the walkthrough recorder', async () => {
  const { html } = await site();
  assert.equal(html.match(/data-section=/g)?.length, 4);
});

test('helpers: cuisine formatting, stable hue, escaping', () => {
  assert.equal(formatCuisine('coffee_shop;filipino'), 'Coffee shop · Filipino');
  assert.equal(formatCuisine(''), '');
  assert.equal(hueFor('Kuro'), hueFor('Kuro'));
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('renderSiteHtml is pure: same lead, same page', async () => {
  const found = await findStage.run({ lead: lead() }, ctx());
  const opts = { senderName: 'X', year: 2026 };
  assert.equal(renderSiteHtml(found, opts), renderSiteHtml(found, opts));
});
