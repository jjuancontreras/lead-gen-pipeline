import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyLead, type Lead } from '../src/lead.ts';
import { writePitchDraft, pitchRefusal, pitchDraftPath } from '../src/pitch-draft.ts';
import { OPT_OUT_MARKER } from '../src/outreach.ts';

function lead(over: Partial<Lead> = {}): Lead {
  return {
    ...emptyLead(), lead_id: 'node/9', name: "Lola Nena's Kusina", category: 'Restaurant', area: 'katipunan',
    status: 'demo_built', tier: 'A', email: 'orders@lolanena.example.net', website_kind: 'facebook',
    demo_url: 'https://lola-nena.vercel.app', video_url: 'https://lola-nena.vercel.app/demo/lola-16x9.mp4',
    ...over,
  };
}

const opts = () => ({ dir: mkdtempSync(join(tmpdir(), 'pitch-')), senderEmail: 'sender@example.com', now: '2026-09-25' });

test('the pitch draft names the business, links the live demo and video, signs off, offers an opt-out', () => {
  const o = opts();
  const d = writePitchDraft(lead(), o);
  const file = readFileSync(d.path, 'utf8');
  assert.equal(d.path, pitchDraftPath(lead(), o.dir));
  assert.match(d.subject, /Lola Nena's Kusina/);
  for (const needle of ['https://lola-nena.vercel.app', 'https://lola-nena.vercel.app/demo/lola-16x9.mp4',
    'sender@example.com', OPT_OUT_MARKER, 'Nothing here has been sent']) {
    assert.ok(file.includes(needle), `draft is missing ${needle}`);
  }
  assert.doesNotMatch(file, /\{\{|\}\}/);
});

test('the pitch file cannot collide with a first-contact draft for the same lead', () => {
  assert.match(pitchDraftPath(lead(), '/d'), /-demo\.md$/);
});

test('no pitch without both links, an address, a sender - and never to an opt-out', () => {
  assert.match(pitchRefusal(lead({ status: 'demo_sent' }), 'x@example.com')!, /demo_built/);
  assert.match(pitchRefusal(lead({ video_url: '' }), 'x@example.com')!, /video/);
  assert.match(pitchRefusal(lead({ demo_url: '' }), 'x@example.com')!, /demo URL/);
  assert.match(pitchRefusal(lead({ email: '' }), 'x@example.com')!, /no email address/);
  assert.match(pitchRefusal(lead(), undefined)!, /SENDER_EMAIL/);
  assert.match(pitchRefusal(lead({ do_not_contact: 'yes' }), 'x@example.com')!, /do_not_contact/);
  assert.equal(pitchRefusal(lead(), 'x@example.com'), null);
});

test('writePitchDraft refuses rather than writing a bad draft', () => {
  const o = opts();
  assert.throws(() => writePitchDraft(lead({ video_url: '' }), o), /video/);
  assert.equal(existsSync(pitchDraftPath(lead(), o.dir)), false);
});
