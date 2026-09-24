import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyLead, type Lead } from '../src/lead.ts';
import { loadFixtureLeads, selectForDemo } from '../src/pipeline/leads.ts';
import { formatTable } from '../src/pipeline/cli.ts';
import { findRefusal } from '../src/pipeline/stages/find.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'businesses.json');

test('the three e2e fixtures load as verified leads with no website', () => {
  const leads = loadFixtureLeads(FIXTURES);
  assert.equal(leads.length, 3);
  for (const l of leads) {
    assert.equal(l.has_website, 'no');
    assert.equal(findRefusal(l), null, `${l.name} would be refused`);
    assert.match(l.email, /@[a-z.]*example\.(com|net|org)$/, 'fixture emails use reserved domains');
  }
});

test('a fixture with a field that is not a lead column is rejected by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-fx-'));
  const path = join(dir, 'bad.json');
  writeFileSync(path, JSON.stringify({ businesses: [
    { lead_id: 'x/1', name: 'X', category: 'Cafe', area: 'katipunan', has_website: 'no', webiste_url: 'typo' },
  ] }));
  assert.throws(() => loadFixtureLeads(path), /webiste_url: not a lead column/);
});

test('a fixture missing a required field is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-fx-'));
  const path = join(dir, 'bad.json');
  writeFileSync(path, JSON.stringify({ businesses: [{ lead_id: 'x/1', name: 'X', area: 'katipunan', has_website: 'no' }] }));
  assert.throws(() => loadFixtureLeads(path), /category/);
});

function lead(over: Partial<Lead>): Lead {
  return {
    ...emptyLead(), lead_id: 'n/0', name: 'N', category: 'Cafe', area: 'katipunan',
    has_website: 'no', status: 'verified', tier: 'A', osm_score: '10', ...over,
  };
}

test('selectForDemo takes verified tier-A leads with no site, best score first, capped', () => {
  const all = [
    lead({ lead_id: 'low', osm_score: '5' }),
    lead({ lead_id: 'high', osm_score: '40' }),
    lead({ lead_id: 'mid', osm_score: '20', status: 'scaffolded' }),
    lead({ lead_id: 'tierB', tier: 'B' }),
    lead({ lead_id: 'hasSite', has_website: 'yes' }),
    lead({ lead_id: 'optedOut', do_not_contact: 'yes' }),
    lead({ lead_id: 'otherArea', area: 'shaw' }),
    lead({ lead_id: 'contacted', status: 'tier1_sent' }),
  ];
  assert.deepEqual(selectForDemo(all, 'katipunan', 2).map((l) => l.lead_id), ['high', 'mid']);
  assert.deepEqual(selectForDemo(all, 'katipunan', 10).map((l) => l.lead_id), ['high', 'mid', 'low']);
});

test('the run table shows each stage and the first error under the lead', () => {
  const table = formatTable([
    { lead_id: 'a', name: 'Kuro', stages: { find: 'done', site: 'done', video: 'failed', email: 'pending' },
      error: { stage: 'video', message: 'ffmpeg missing' } },
  ]);
  assert.match(table, /Kuro\s+done\s+done\s+FAILED\s+-/);
  assert.match(table, /video: ffmpeg missing/);
});
