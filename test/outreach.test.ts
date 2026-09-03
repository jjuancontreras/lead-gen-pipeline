import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderTemplate, pickChannel, availableTemplates, interpolate, variantFor,
  templateForChannel, channelForTemplate, SENDER,
} from '../src/outreach.ts';
import {
  selectPool, destination, draftFileBody, mimeMessage, withdrawSuppressedDrafts,
  isOpeningEligible, isFollowUpDue,
} from '../src/stages/outreach.ts';
import { followUpTemplateFor, CADENCE } from '../src/cadence.ts';
import { WITHDRAWN_MARKER } from '../src/draft-file.ts';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyLead, type Lead } from '../src/lead.ts';

/** A verified B-tier Katipunan cafe whose only presence is a Facebook page. */
function lead(over: Partial<Lead> = {}): Lead {
  return {
    ...emptyLead(),
    lead_id: 'node/1', name: 'Test Cafe', category: 'Cafe', area: 'katipunan',
    osm_score: '25',
    website_url: 'https://www.facebook.com/testcafe', website_kind: 'facebook',
    email: 'hello@testcafe.ph',
    status: 'verified', tier: 'B',
    ...over,
  };
}

const FIRST_CONTACT = ['email-first', 'instagram-dm', 'messenger-dm'] as const;
const both = (over: Partial<Lead> = {}) => [
  lead({ website_kind: 'facebook', ...over }),
  lead({ website_kind: 'none', website_url: '', ...over }),
];

// ---- suppression (RA 10173) -------------------------------------------------

test('CRITICAL: a suppressed lead is refused by every template', () => {
  // The opt-out list is the whole compliance posture. If this regresses,
  // the pipeline messages people who explicitly asked it not to.
  for (const flag of ['yes', 'TRUE', 'x', '2026-01-14', 'owner asked by phone']) {
    for (const name of availableTemplates()) {
      assert.throws(
        () => renderTemplate(name, lead({ do_not_contact: flag })),
        /do_not_contact|RA 10173/,
        `${name} rendered for a lead with do_not_contact="${flag}"`,
      );
    }
  }
});

test('CRITICAL: pickChannel returns null for a suppressed lead', () => {
  // Second gate: a caller that forgets renderTemplate still cannot address them.
  const l = lead({ do_not_contact: 'yes', instagram: '@testcafe', phone: '0917' });
  assert.equal(pickChannel(l), null);
});

test('the falsy do_not_contact values are not treated as opt-outs', () => {
  // A blank/no/false/0 cell is the normal state of the column, not a flag.
  for (const flag of ['', 'no', 'FALSE', '0', '  ']) {
    assert.ok(renderTemplate('email-first', lead({ do_not_contact: flag })).body.length > 0);
  }
});

test('suppressed leads never reach the outreach pool', () => {
  const pool = selectPool([lead({ do_not_contact: 'yes' })], {
    area: 'katipunan', tiers: ['B'], today: '2026-09-02',
  });
  assert.equal(pool.length, 0);
});

// ---- the unresolved-placeholder guard ---------------------------------------

test('CRITICAL: an unknown placeholder throws instead of rendering', () => {
  // A template leaking "{{name}}" into a real inbox is unrecoverable.
  assert.throws(() => interpolate('Hi {{nope}}', { name: 'x' }), /unresolved.*nope/);
});

test('an empty value counts as unresolved, not as an empty substitution', () => {
  // Otherwise a lead with no demo gets mailed "here it is: ".
  assert.throws(() => interpolate('see {{demo_url}}', { demo_url: '' }), /unresolved/);
  assert.throws(() => interpolate('see {{demo_url}}', { demo_url: '   ' }), /unresolved/);
});

test('a malformed placeholder throws too', () => {
  // "{{ name" never matches the substitution regex, so it would sail through.
  assert.throws(() => interpolate('Hi {{ name', { name: 'x' }), /malformed/);
  assert.throws(() => interpolate('Hi {name}}', { name: 'x' }), /malformed/);
});

test('renderTemplate surfaces the missing field by name', () => {
  // area is blank -> area_label cannot be derived -> refuse, do not guess.
  assert.throws(() => renderTemplate('email-first', lead({ area: '' })), /area_label/);
});

test('every template renders clean for a complete lead, both variants', () => {
  for (const name of availableTemplates()) {
    for (const l of both()) {
      const r = renderTemplate(name, l);
      assert.ok(!r.body.includes('{{'), `${name} left a placeholder in the body`);
      assert.ok(!r.body.includes('}}'), `${name} left a placeholder in the body`);
      assert.ok(!(r.subject ?? '').includes('{{'), `${name} left a placeholder in the subject`);
      assert.ok(r.body.includes('Test Cafe'), `${name} never names the business`);
    }
  }
});

test('an unknown template name throws and lists the real ones', () => {
  assert.throws(() => renderTemplate('does-not-exist', lead()), /no template.*email-first/s);
});

// ---- compliance: identify yourself, offer an opt-out ------------------------

test('CRITICAL: every first-contact template identifies him and offers an opt-out', () => {
  // Cold B2B outreach under PH law. The regexes are deliberately tied to the
  // exact phrasings in templates/outreach - changing the copy should force a
  // re-read of this rule, not silently drop it.
  for (const name of FIRST_CONTACT) {
    for (const l of both()) {
      const text = `${renderTemplate(name, l).subject ?? ''}\n${renderTemplate(name, l).body}`;
      assert.match(text, /Jfer Contreras/, `${name} does not give his name`);
      assert.match(text, /Ateneo de Manila University/, `${name} does not name the university`);
      assert.match(text, /build\w*\s+websites/i, `${name} does not say what he does`);
      assert.match(text, /no thanks|will not message again/i, `${name} has no opt-out line`);
    }
  }
});

test('the email quotes the real prices and never invents a detail', () => {
  const body = renderTemplate('email-first', lead()).body;
  assert.ok(body.includes(SENDER.price_range), 'build price missing');
  assert.ok(body.includes(SENDER.maintenance_price), 'maintenance price missing');
  assert.ok(body.includes(SENDER.client_capacity), 'capacity missing');
});

// ---- variants ---------------------------------------------------------------

test('website_kind chooses the variant', () => {
  for (const kind of ['facebook', 'instagram', 'tiktok', 'linktree'] as const) {
    assert.equal(variantFor(lead({ website_kind: kind })), 'social', kind);
  }
  for (const kind of ['none', '', 'delivery_app', 'marketplace'] as const) {
    assert.equal(variantFor(lead({ website_kind: kind })), 'bare', kind || '(blank)');
  }
});

test('the social variant leads with "nowhere to send people"', () => {
  const body = renderTemplate('email-first', lead({ website_kind: 'facebook' })).body;
  assert.match(body, /Facebook page/, 'should name the page they actually have');
  assert.match(body, /nowhere to send them/);
});

test('the no-presence variant never claims to have seen a page', () => {
  const body = renderTemplate('email-first', lead({ website_kind: 'none', website_url: '' })).body;
  assert.match(body, /could not find a website/);
  assert.doesNotMatch(body, /Facebook page|Instagram page/);
});

// ---- DM length --------------------------------------------------------------

test('DMs stay short - they are read on a phone', () => {
  for (const name of ['instagram-dm', 'messenger-dm']) {
    for (const l of both()) {
      const body = renderTemplate(name, l).body.trim();
      assert.ok(body.length <= 500, `${name} is ${body.length} chars - a wall of text`);
      assert.ok(!body.includes('\n'), `${name} is multi-paragraph`);
      assert.equal(renderTemplate(name, l).subject, undefined, `${name} should have no subject`);
    }
  }
});

test('the email has a subject and the subject names the business', () => {
  const r = renderTemplate('email-first', lead());
  assert.ok(r.subject && r.subject.includes('Test Cafe'), `got subject ${r.subject}`);
  assert.ok(!r.body.startsWith('Subject:'), 'subject leaked into the body');
});

// ---- channel selection ------------------------------------------------------

test('pickChannel follows email -> instagram -> facebook -> tiktok', () => {
  const all = { email: 'a@b.ph', instagram: '@x', facebook: 'fb/x', tiktok: '@x' };
  assert.equal(pickChannel(lead(all)), 'email');
  assert.equal(pickChannel(lead({ ...all, email: '' })), 'instagram');
  assert.equal(pickChannel(lead({ ...all, email: '', instagram: '' })), 'facebook');
  assert.equal(pickChannel(lead({ ...all, email: '', instagram: '', facebook: '' })), 'tiktok');
});

test('a phone number is not a message channel, and does not block the socials', () => {
  // Phone outranks the socials for a human, but nothing renders to it - so it
  // is stepped over rather than stranding the lead on null.
  assert.equal(pickChannel(lead({ email: '', phone: '0917', instagram: '@x' })), 'instagram');
  assert.equal(pickChannel(lead({ email: '', phone: '0917' })), null);
  assert.equal(pickChannel(lead({ email: '' })), null);
});

test('each channel maps to copy written for it', () => {
  assert.equal(templateForChannel('email'), 'email-first');
  assert.equal(templateForChannel('instagram'), 'instagram-dm');
  assert.equal(templateForChannel('facebook'), 'messenger-dm');
  assert.equal(templateForChannel('tiktok'), 'instagram-dm');
  assert.equal(channelForTemplate('email-first'), 'email');
  assert.equal(channelForTemplate('follow-up-3'), null, 'follow-ups suit any channel');
});

test('availableTemplates lists logical names, variants collapsed', () => {
  assert.deepEqual(availableTemplates(), [
    'breakup-14', 'email-first', 'follow-up-3', 'follow-up-7',
    'instagram-dm', 'messenger-dm',
  ]);
});

// ---- pool selection ---------------------------------------------------------

const TODAY = '2026-09-02';
const sel = (leads: Lead[], over: Partial<Parameters<typeof selectPool>[1]> = {}) =>
  selectPool(leads, { area: 'katipunan', tiers: ['B'], today: TODAY, ...over });

test('first contact takes uncontacted B-tier verified leads only', () => {
  const pool = sel([
    lead({ lead_id: 'a' }),
    lead({ lead_id: 'b', tier: 'A' }),
    lead({ lead_id: 'c', status: 'tier1_sent' }),
    lead({ lead_id: 'd', first_contacted_at: '2026-08-01' }),
    lead({ lead_id: 'e', area: 'elsewhere' }),
  ]);
  assert.deepEqual(pool.map((l) => l.lead_id), ['a']);
});

test('A-tier can be opted in explicitly, for when a demo is already built', () => {
  const pool = sel([lead({ lead_id: 'b', tier: 'A' })], { tiers: ['A', 'B'] });
  assert.deepEqual(pool.map((l) => l.lead_id), ['b']);
});

test('a follow-up takes contacted leads whose next action is due', () => {
  const pool = sel([
    lead({ lead_id: 'due', status: 'tier1_sent', next_action_date: '2026-09-01' }),
    lead({ lead_id: 'today', status: 'tier1_sent', next_action_date: TODAY }),
    lead({ lead_id: 'later', status: 'tier1_sent', next_action_date: '2026-09-20' }),
    lead({ lead_id: 'unset', status: 'tier1_sent', next_action_date: '' }),
  ], { template: 'follow-up-3' });
  assert.deepEqual(pool.map((l) => l.lead_id).sort(), ['due', 'today']);
});

test('a channel-specific template only takes leads on that channel', () => {
  const leads = [
    lead({ lead_id: 'mail' }),
    lead({ lead_id: 'gram', email: '', instagram: '@x' }),
  ];
  assert.deepEqual(sel(leads, { template: 'instagram-dm' }).map((l) => l.lead_id), ['gram']);
  assert.deepEqual(sel(leads, { template: 'email-first' }).map((l) => l.lead_id), ['mail']);
});

test('the pool is ordered by stage-1 score', () => {
  const pool = sel([
    lead({ lead_id: 'low', osm_score: '10' }),
    lead({ lead_id: 'high', osm_score: '40' }),
  ]);
  assert.deepEqual(pool.map((l) => l.lead_id), ['high', 'low']);
});

// ---- draft output -----------------------------------------------------------

test('destination builds a link a human can actually open', () => {
  assert.equal(destination(lead(), 'email'), 'hello@testcafe.ph');
  assert.equal(destination(lead({ instagram: '@testcafe' }), 'instagram'),
    'https://www.instagram.com/testcafe/');
  assert.equal(destination(lead({ facebook: 'https://fb.com/testcafe' }), 'facebook'),
    'https://fb.com/testcafe');
  assert.equal(destination(lead({ tiktok: 'testcafe' }), 'tiktok'),
    'https://www.tiktok.com/@testcafe');
});

test('a draft file says it was not sent, and hides the subject on DMs', () => {
  const r = renderTemplate('instagram-dm', lead({ instagram: '@testcafe' }));
  const md = draftFileBody(lead({ instagram: '@testcafe' }), 'instagram', 'instagram-dm', r);
  assert.match(md, /has been sent/i);
  assert.match(md, /instagram\.com\/testcafe/);
  assert.doesNotMatch(md, /^Subject:/m, 'a DM has no subject to paste');
});

test('a non-ASCII subject is MIME encoded rather than mangled', () => {
  assert.match(mimeMessage('a@b.ph', 'Cafe Nino', 'hi'), /^Subject: Cafe Nino$/m);
  assert.match(mimeMessage('a@b.ph', 'Cafe Niño', 'hi'), /^Subject: =\?UTF-8\?B\?/m);
});

test('a scaffolded lead with no first-contact timestamp is included in the pool', () => {
  const pool = sel([
    lead({ lead_id: 'scaffolded-uncontacted', status: 'scaffolded', first_contacted_at: '' }),
    lead({ lead_id: 'scaffolded-contacted', status: 'scaffolded', first_contacted_at: '2026-08-01' }),
  ]);
  assert.deepEqual(pool.map((l) => l.lead_id), ['scaffolded-uncontacted']);
});

// ---- QA #4: one run opens conversations AND continues them ------------------

test('CRITICAL: with no template, a run picks up new leads and due follow-ups together', () => {
  // Arrange - the campaign never passes a template. Before this, only one of
  // these two ever came back, so the 3/7/14 cadence was unreachable from it.
  const leads = [
    lead({ lead_id: 'new', status: 'verified', first_contacted_at: '' }),
    lead({ lead_id: 'due', status: 'tier1_sent', first_contacted_at: '2026-08-30', next_action_date: TODAY }),
    lead({ lead_id: 'not-due', status: 'tier1_sent', next_action_date: '2026-12-01' }),
    lead({ lead_id: 'finished', status: 'tier1_sent', next_action_date: '' }),
  ];

  // Act
  const pool = sel(leads);

  // Assert
  assert.deepEqual(pool.map((l) => l.lead_id).sort(), ['due', 'new']);
});

test('naming a template still restricts the pool to that one kind of touch', () => {
  const leads = [
    lead({ lead_id: 'new', status: 'verified' }),
    lead({ lead_id: 'due', status: 'tier1_sent', next_action_date: TODAY }),
  ];

  assert.deepEqual(sel(leads, { template: 'email-first' }).map((l) => l.lead_id), ['new']);
  assert.deepEqual(sel(leads, { template: 'follow-up-3' }).map((l) => l.lead_id), ['due']);
});

test('a due follow-up gets the step its first contact date has earned', () => {
  // Arrange - contacted on Aug 30, so Sep 2 is day 3.
  const l = lead({ status: 'tier1_sent', first_contacted_at: '2026-08-30', next_action_date: TODAY });

  // Act
  const [due] = sel([l]);
  const template = followUpTemplateFor(due!.first_contacted_at, TODAY);

  // Assert
  assert.equal(template, CADENCE[0]!.template);
  assert.equal(followUpTemplateFor('2026-08-19', TODAY), 'breakup-14');
});

test('a suppressed lead is excluded from both halves of the pool', () => {
  const pool = sel([
    lead({ lead_id: 'new', status: 'verified', do_not_contact: 'yes' }),
    lead({ lead_id: 'due', status: 'tier1_sent', next_action_date: TODAY, do_not_contact: 'yes' }),
  ]);
  assert.deepEqual(pool, []);
});

// ---- QA #2: an opt-out empties the draft already on disk --------------------

/** A throwaway drafts directory, so no test can touch the real data/drafts. */
function draftsDir(): string {
  return mkdtempSync(join(tmpdir(), 'pipeline-drafts-'));
}

test('CRITICAL: a lead flagged after drafting keeps no sendable text on disk', () => {
  // Arrange
  const dir = draftsDir();
  const file = join(dir, 'test-cafe.md');
  writeFileSync(file, '# Test Cafe\n\n```\nhello@testcafe.ph\n```\n');
  const l = lead({ do_not_contact: 'owner asked by phone' });

  // Act
  const withdrawn = withdrawSuppressedDrafts([l], 'katipunan', '2026-09-02', dir);

  // Assert
  assert.deepEqual(withdrawn, [{ name: 'Test Cafe', file: 'test-cafe.md' }]);
  const after = readFileSync(file, 'utf8');
  assert.match(after, new RegExp(WITHDRAWN_MARKER.replace('#', '#')));
  assert.doesNotMatch(after, /hello@testcafe\.ph/, 'the address must be gone');
  assert.doesNotMatch(after, /```/, 'no copy block may survive');
  assert.ok(existsSync(file), 'the record is emptied, not deleted');
});

test('the sweep leaves everyone else, and every other area, alone', () => {
  // Arrange
  const dir = draftsDir();
  const keep = join(dir, 'test-cafe.md');
  const other = join(dir, 'other-area.md');
  writeFileSync(keep, 'original');
  writeFileSync(other, 'original');

  // Act
  const withdrawn = withdrawSuppressedDrafts([
    lead(),
    lead({ lead_id: 'node/2', name: 'Other Area', area: 'maginhawa', do_not_contact: 'yes' }),
  ], 'katipunan', '2026-09-02', dir);

  // Assert
  assert.deepEqual(withdrawn, []);
  assert.equal(readFileSync(keep, 'utf8'), 'original');
  assert.equal(readFileSync(other, 'utf8'), 'original');
});

test('a suppressed lead with no draft on disk writes no tombstone', () => {
  const dir = draftsDir();

  const withdrawn = withdrawSuppressedDrafts(
    [lead({ do_not_contact: 'yes' })], 'katipunan', '2026-09-02', dir);

  assert.deepEqual(withdrawn, []);
  assert.equal(existsSync(join(dir, 'test-cafe.md')), false);
});

// ---- QA security: a hand-edited sheet cell cannot inject a MIME header ----

test('CRITICAL: a CRLF in the To address cannot splice in an extra header', () => {
  // Arrange - what a hand-edited sheet cell could contain.
  const to = 'real@testcafe.ph\r\nBcc: attacker@evil.example';

  // Act
  const raw = mimeMessage(to, 'Hello', 'body');

  // Assert - the CRLF is neutralized, so the payload is exactly one header
  // line per field. "Bcc:" may still appear as inert text inside the To
  // value, but it must never start its own header line.
  const lines = raw.split('\r\n');
  assert.equal(lines.filter((l) => l.startsWith('To:')).length, 1);
  assert.equal(lines.filter((l) => /^Bcc:/i.test(l)).length, 0, 'no forged Bcc header line');
  assert.equal(lines[0], 'To: real@testcafe.ph Bcc: attacker@evil.example');
});

// ---- the shared eligibility rule, used by both selectPool and the console -

test('isOpeningEligible: verified or scaffolded, never touched, is eligible', () => {
  assert.equal(isOpeningEligible(lead({ status: 'verified' })), true);
  assert.equal(isOpeningEligible(lead({ status: 'scaffolded' })), true);
});

test('isOpeningEligible: any other status, or a lead already contacted, is not', () => {
  assert.equal(isOpeningEligible(lead({ status: 'needs_manual' })), false);
  assert.equal(isOpeningEligible(lead({ status: 'replied' })), false);
  assert.equal(isOpeningEligible(lead({ status: 'verified', first_contacted_at: '2026-08-01' })), false);
});

test('isFollowUpDue: tier1_sent with a next_action_date on or before today', () => {
  assert.equal(isFollowUpDue(lead({ status: 'tier1_sent', next_action_date: TODAY }), TODAY), true);
  assert.equal(isFollowUpDue(lead({ status: 'tier1_sent', next_action_date: '2026-08-01' }), TODAY), true);
});

test('isFollowUpDue: false when not due yet, finished, or the wrong status', () => {
  assert.equal(isFollowUpDue(lead({ status: 'tier1_sent', next_action_date: '2026-12-01' }), TODAY), false);
  assert.equal(isFollowUpDue(lead({ status: 'tier1_sent', next_action_date: '' }), TODAY), false, 'sequence finished');
  assert.equal(isFollowUpDue(lead({ status: 'verified', next_action_date: TODAY }), TODAY), false);
});
