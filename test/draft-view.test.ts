import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { draftView } from '../src/draft-view.ts';
import { draftFileBody, draftFileNames, withdrawnBody } from '../src/draft-file.ts';
import { renderTemplate } from '../src/outreach.ts';
import { emptyLead, type Lead } from '../src/lead.ts';

const NOW = '2026-09-23';

const lead = (over: Partial<Lead> = {}): Lead => ({
  ...emptyLead(),
  lead_id: 'node/1', name: 'Test Cafe', category: 'Cafe', area: 'katipunan',
  website_url: 'https://www.facebook.com/testcafe', website_kind: 'facebook',
  email: 'hello@testcafe.ph', status: 'verified', tier: 'B',
  ...over,
});

const emptyDir = () => mkdtempSync(join(tmpdir(), 'pipeline-draft-view-'));

function dirWith(l: Lead, body: string): string {
  const dir = emptyDir();
  writeFileSync(join(dir, draftFileNames(l)[0]), body);
  return dir;
}

test('CRITICAL: a suppressed lead shows nothing, even with a draft on disk', () => {
  const l = lead({ do_not_contact: 'yes', status: 'drafted' });
  const dir = dirWith(l, draftFileBody(lead(), 'email', 'email-first', renderTemplate('email-first', lead()), NOW));
  assert.deepEqual(draftView(l, NOW, dir), { kind: 'suppressed' });
});

test('a withdrawn draft is reported as withdrawn, never parsed', () => {
  const l = lead({ status: 'drafted' });
  const view = draftView(l, NOW, dirWith(l, withdrawnBody(l.name, NOW)));
  assert.equal(view.kind, 'withdrawn');
});

test('a saved draft comes back as its fields, and can be marked sent once drafted', () => {
  const l = lead({ status: 'drafted', channel_used: 'email' });
  const r = renderTemplate('email-first', lead());
  const view = draftView(l, NOW, dirWith(l, draftFileBody(l, 'email', 'email-first', r, NOW)));
  assert.equal(view.kind, 'draft');
  if (view.kind !== 'draft') return;
  assert.equal(view.to, 'hello@testcafe.ph');
  assert.equal(view.subject, r.subject);
  assert.equal(view.body, r.body.replace(/\n+$/, ''));
  assert.equal(view.channel, 'email');
  assert.equal(view.canMarkSent, true);
  assert.match(view.link ?? '', /^https:\/\/mail\.google\.com\//);
});

test('a draft predating the fenced format falls back to the raw file', () => {
  const l = lead({ status: 'drafted' });
  const raw = '# Test Cafe\n\nSubject: hi\n\nold unstructured body\n';
  const view = draftView(l, NOW, dirWith(l, raw));
  assert.equal(view.kind, 'draft');
  if (view.kind === 'draft') assert.equal(view.markdown, raw);
});

test('with nothing on disk, a lead no run would touch gets no preview', () => {
  assert.deepEqual(draftView(lead({ status: 'needs_manual' }), NOW, emptyDir()),
    { kind: 'none', reason: 'No draft or preview available at this stage.' });
});

test('with nothing on disk, an eligible lead with no channel says so', () => {
  const l = lead({ email: '', website_url: '', website_kind: 'none' });
  assert.deepEqual(draftView(l, NOW, emptyDir()),
    { kind: 'none', reason: 'No contact channel on file yet.' });
});

test('with nothing on disk, an eligible lead gets an unsaved preview it cannot mark sent', () => {
  const view = draftView(lead(), NOW, emptyDir());
  assert.equal(view.kind, 'preview');
  if (view.kind !== 'preview') return;
  assert.equal(view.channel, 'email');
  assert.equal(view.to, 'hello@testcafe.ph');
  assert.equal(view.canMarkSent, false);
  assert.match(view.link ?? '', /^https:\/\/mail\.google\.com\//);
});
