import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFileBody, draftIndexBody, gmailComposeLink, destination,
  withdrawnBody, WITHDRAWN_MARKER, MAX_COMPOSE_URL, draftFileNames, INDEX_FILE,
  parseDraftBody, type DraftRow,
} from '../src/draft-file.ts';
import { renderTemplate, type Rendered } from '../src/outreach.ts';
import { emptyLead, type Lead } from '../src/lead.ts';

/** A verified B-tier Katipunan cafe, reachable by email and on Instagram. */
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

/** Contents of every fenced block, in order. */
function fences(md: string): string[] {
  const out: string[] = [];
  const re = /^(`{3,})[^\n]*\n([\s\S]*?)\n\1$/gm;
  for (const m of md.matchAll(re)) out.push(m[2]!);
  return out;
}

test('an email draft puts To, Subject and Body in three separate fenced blocks', () => {
  const l = lead();
  const r = renderTemplate('email-first', l);

  const md = draftFileBody(l, 'email', 'email-first', r, '2026-09-03');

  const blocks = fences(md);
  assert.equal(blocks.length, 3, 'one copy button per field');
  assert.equal(blocks[0], 'hello@testcafe.ph');
  assert.equal(blocks[1], r.subject);
  assert.match(md, /### To\n/);
  assert.match(md, /### Subject\n/);
  assert.match(md, /### Body\n/);
});

test('the fenced body is the rendered body, with nothing else pulled in', () => {
  const l = lead();
  const r = renderTemplate('email-first', l);

  const md = draftFileBody(l, 'email', 'email-first', r, '2026-09-03');

  // The trailing newline is stripped so a paste does not carry a blank line.
  assert.equal(fences(md)[2], r.body.replace(/\n+$/, ''));
});

test('the subject never sits on a line adjacent to the body', () => {
  const l = lead();
  const r = renderTemplate('email-first', l);

  const md = draftFileBody(l, 'email', 'email-first', r, '2026-09-03');

  const lines = md.split('\n');
  const subjectAt = lines.findIndex((x) => x === r.subject);
  assert.ok(subjectAt > 0, 'the subject is on a line of its own');
  // Fenced, so the lines either side are the fence - never body text.
  assert.match(lines[subjectAt - 1]!, /^`{3,}$/);
  assert.match(lines[subjectAt + 1]!, /^`{3,}$/);
});

test('a DM draft is one message block: no To field, and still no subject line', () => {
  const l = lead({ instagram: '@testcafe' });
  const r = renderTemplate('instagram-dm', l);

  const md = draftFileBody(l, 'instagram', 'instagram-dm', r, '2026-09-03');

  assert.equal(fences(md).length, 1, 'a DM is one paste');
  assert.match(md, /### Message\n/);
  assert.doesNotMatch(md, /### To\n/, 'you open a profile, you do not paste an address');
  assert.doesNotMatch(md, /^Subject:/m, 'a DM has no subject to paste');
  assert.match(md, /instagram\.com\/testcafe/);
});

test('a compose link round-trips every field it carries', () => {
  const to = 'hello@testcafe.ph';
  const subject = 'A free website demo for Test Cafe';
  const body = 'Hi Test Cafe,\n\nLine two.\n';

  const url = gmailComposeLink(to, subject, body);

  assert.ok(url, 'well inside the length ceiling');
  const q = new URL(url).searchParams;
  assert.equal(q.get('to'), to);
  assert.equal(q.get('su'), subject);
  assert.equal(q.get('body'), body);
});

test('a compose link escapes parentheses, which would otherwise end the markdown link', () => {
  const body = 'Want it? (If not, just say so and I will not message again.)';

  const url = gmailComposeLink('a@b.ph', 'Hi', body)!;

  assert.doesNotMatch(url, /[()]/, 'a literal ) would terminate the link destination');
  assert.equal(new URL(url).searchParams.get('body'), body);
});

test('an over-long message gets no compose link, and the draft says why', () => {
  const long = 'x'.repeat(MAX_COMPOSE_URL + 1);
  const l = lead();
  const r: Rendered = { subject: 'Hi', body: long };

  assert.equal(gmailComposeLink('a@b.ph', 'Hi', long), null);

  const md = draftFileBody(l, 'email', 'email-first', r, '2026-09-03');
  assert.doesNotMatch(md, /mail\.google\.com/);
  assert.match(md, /too long to fit in a compose link/i);
  assert.equal(fences(md).length, 3, 'the fields are still copyable');
});

test('the fence widens so a body containing a fence cannot break out', () => {
  const l = lead({ instagram: '@testcafe' });
  const r: Rendered = { body: 'before\n```\ninside\n```\nafter\n' };

  const md = draftFileBody(l, 'instagram', 'instagram-dm', r, '2026-09-03');

  assert.match(md, /^`{4,}$/m, 'the outer fence outruns the inner one');
  assert.equal(fences(md)[0], 'before\n```\ninside\n```\nafter');
});

test('the index lists one checkbox per draft, linked and addressed', () => {
  const rows: DraftRow[] = [{
    name: 'Test Cafe', channel: 'email', destination: 'hello@testcafe.ph',
    tier: 'B', template: 'email-first', file: 'test-cafe.md',
  }];

  const md = draftIndexBody(rows, [{ file: 'old-place.md', modified: '2026-09-02' }], '2026-09-03');

  assert.match(md, /- \[ \] \*\*Test Cafe\*\*/);
  assert.match(md, /hello@testcafe\.ph/);
  assert.match(md, /\(\.\/test-cafe\.md\)/);
  assert.match(md, /has been sent/i);
  // Unsent drafts from an earlier run are still unsent.
  assert.match(md, /## Earlier drafts/);
  assert.match(md, /old-place\.md/);
});

test('destination turns a bare handle into a profile URL, and leaves email alone', () => {
  assert.equal(destination(lead(), 'email'), 'hello@testcafe.ph');
  assert.equal(
    destination(lead({ instagram: '@testcafe' }), 'instagram'),
    'https://www.instagram.com/testcafe/',
  );
});

// ---- withdrawal (QA #2: an opted-out lead must not keep a sendable draft) ----

test('CRITICAL: a withdrawn draft keeps no sendable text at all', () => {
  // Arrange
  const l = lead();
  const previous = draftFileBody(l, 'email', 'email-first', renderTemplate('email-first', l), '2026-09-01');

  // Act
  const md = withdrawnBody('Test Cafe', '2026-09-02');

  // Assert
  assert.match(md, /^# Test Cafe$/m);
  assert.match(md, new RegExp(WITHDRAWN_MARKER.replace(/[#]/g, '\#')));
  assert.match(md, /2026-09-02/);
  assert.doesNotMatch(md, /hello@testcafe\.ph/, 'the address must be gone');
  assert.doesNotMatch(md, /mail\.google\.com/, 'no compose link may survive');
  assert.doesNotMatch(md, /```/, 'no copy-button block may survive');
  assert.ok(previous.includes('hello@testcafe.ph'), 'guard: the old draft really did carry it');
});

test('the index lists withdrawn drafts in their own section, not as pending', () => {
  // Arrange
  const withdrawn = [{ name: 'Test Cafe', file: 'test-cafe.md' }];

  // Act
  const md = draftIndexBody([], [], '2026-09-02', withdrawn);

  // Assert
  const section = md.slice(md.indexOf('do_not_contact'));
  assert.match(md, /do_not_contact/i);
  assert.match(section, /test-cafe\.md/);
  assert.doesNotMatch(md, /- \[ \] \*\*Test Cafe\*\*/, 'never offered as ready to send');
});

test('the index stays valid when a run withdraws and drafts nothing', () => {
  const md = draftIndexBody([], [], '2026-09-02', []);
  assert.match(md, /Nothing new this run/);
  assert.doesNotMatch(md, /do_not_contact/i);
});

// ---- QA security: scraped text cannot break the markdown or the link -------

test('CRITICAL: a business name cannot close a link early or inject markdown', () => {
  // Arrange - a name shaped to break out of "](...)" and add a fake link.
  const l = lead({ name: 'Evil Cafe](https://phish.example "click") [PAY NOW' });
  const r = renderTemplate('email-first', l);

  // Act
  const md = draftFileBody(l, 'email', 'email-first', r, '2026-09-03');

  // Assert - the raw sequence must not survive unescaped in the header line.
  assert.doesNotMatch(md.split('\n---\n')[0]!, /\]\(https:\/\/phish\.example/);
});

test('CRITICAL: a newline in a scraped name cannot forge a heading in our own header block', () => {
  // The name also flows into the rendered body, inside a fence, where a raw
  // newline is the template's own content and is not a markdown-injection
  // risk - a fence is never interpreted. Only the header block above the
  // `---` rule is *our* unfenced markdown, and that is what must stay inert.
  const l = lead({ name: 'Test Cafe\n\n## FAKE HEADING\n[click me](https://evil.example)' });
  const r = renderTemplate('email-first', l);

  const md = draftFileBody(l, 'email', 'email-first', r, '2026-09-03');

  assert.doesNotMatch(md.split('\n---\n')[0]!, /^## FAKE HEADING$/m);
});

test('a social link destination that is not a real URL renders no clickable link', () => {
  const l = lead({
    website_kind: 'instagram', website_url: undefined, instagram: 'not a url) [pwned](evil',
    email: undefined,
  });
  const r: Rendered = { subject: undefined, body: 'hi' };

  const md = draftFileBody(l, 'instagram', 'instagram-dm', r, '2026-09-03');

  assert.doesNotMatch(md, /\[Open the Instagram profile\]\(not a url\)/);
});

test('a well-formed social URL still renders a normal clickable link', () => {
  const l = lead({
    website_kind: 'instagram', website_url: undefined, instagram: '@testcafe', email: undefined,
  });
  const r: Rendered = { subject: undefined, body: 'hi' };

  const md = draftFileBody(l, 'instagram', 'instagram-dm', r, '2026-09-03');

  assert.match(md, /\[Open the Instagram profile\]\(https:\/\/www\.instagram\.com\/testcafe\/\)/);
});

// ---- QA security: filename collisions never bury a withdrawal record ------

test('draftFileNames avoids the literal index filename', () => {
  const l = lead({ name: 'Index', lead_id: 'node/9' });

  const [primary] = draftFileNames(l);

  assert.notEqual(primary.toLowerCase(), INDEX_FILE.toLowerCase());
});

test('draftFileNames offers a second, lead-specific name for slug collisions', () => {
  const a = lead({ name: 'Cafe!!', lead_id: 'node/1' });
  const b = lead({ name: 'Cafe??', lead_id: 'node/2' });

  const [primaryA] = draftFileNames(a);
  const [primaryB] = draftFileNames(b);
  const [, altB] = draftFileNames(b);

  assert.equal(primaryA, primaryB, 'the two names do slugify the same');
  assert.notEqual(altB, primaryB, 'the fallback name must differ');
  assert.match(altB, /node-2/);
});

// ---- parseDraftBody: the inverse of field() --------------------------------

test('parseDraftBody round-trips an email draft back to its three fields', () => {
  // Arrange
  const l = lead();
  const r = renderTemplate('email-first', l);
  const md = draftFileBody(l, 'email', 'email-first', r, '2026-09-03');

  // Act
  const { fields, link } = parseDraftBody(md);

  // Assert - byte-for-byte, not just "contains".
  assert.equal(fields.to, 'hello@testcafe.ph');
  assert.equal(fields.subject, r.subject);
  // field() strips a trailing newline before fencing; parsing the fence back
  // naturally loses it too - draftFileBody's own tests rely on the same fact.
  assert.equal(fields.body, r.body.replace(/\n+$/, ''));
  assert.match(link ?? '', /^https:\/\/mail\.google\.com\/mail\/\?view=cm/);
});

test('parseDraftBody round-trips a DM draft to one Message field and a profile link', () => {
  const l = lead({ website_kind: 'instagram', website_url: undefined, instagram: '@testcafe', email: undefined });
  const r = renderTemplate('instagram-dm', l);
  const md = draftFileBody(l, 'instagram', 'instagram-dm', r, '2026-09-03');

  const { fields, link } = parseDraftBody(md);

  // field() strips a trailing newline before fencing (see the test above);
  // parseDraftBody reads that fence back, so it naturally loses it too.
  assert.equal(fields.message, r.body.replace(/\n+$/, ''));
  assert.equal(fields.to, undefined, 'a DM has no To field to parse');
  assert.equal(link, 'https://www.instagram.com/testcafe/');
});

test('parseDraftBody finds nothing in a pre-fenced-format file, not a crash', () => {
  // The six real drafts on disk predate this format and have no "### Label"
  // blocks - the console falls back to the raw file for these.
  const old = '# Fred\'s Revolucion\n\n---\n\nSubject: Hello\nHi there,\n\nbody text\n';

  const { fields, link } = parseDraftBody(old);

  assert.deepEqual(fields, {});
  assert.equal(link, null);
});
