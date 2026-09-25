import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyLead, type Lead } from '../src/lead.ts';
import { buildDemoKit, demoSlugFor, recordingDir, suggestedVideoUrl, isRecorded } from '../src/demo-kit.ts';

function lead(over: Partial<Lead> = {}): Lead {
  return {
    ...emptyLead(), lead_id: 'node/5', name: 'Kapihan sa Kanto', category: 'Cafe', area: 'katipunan',
    status: 'demo_queued', tier: 'A', phone: '0917 555 0101', instagram: '@kapihan', ...over,
  };
}

test('Build demo scaffolds the folder, its content seed and its BUILD-PROMPT', () => {
  const root = mkdtempSync(join(tmpdir(), 'kit-'));
  const kit = buildDemoKit(lead(), root);
  assert.equal(kit.slug, 'kapihan-sa-kanto');
  assert.equal(kit.reused, false);
  assert.ok(kit.buildPrompt && existsSync(kit.buildPrompt), 'BUILD-PROMPT written');
  const content = JSON.parse(readFileSync(join(kit.path, 'src', 'data', 'content.json'), 'utf8'));
  assert.equal(content.brand.name, 'Kapihan sa Kanto');
  assert.ok(kit.port >= 3011, `port ${kit.port}`);
  assert.ok(existsSync(join(root, '.claude', 'launch.json')));
});

test('Build demo on a folder that already exists adopts it instead of failing or overwriting', () => {
  const root = mkdtempSync(join(tmpdir(), 'kit-'));
  const first = buildDemoKit(lead(), root);
  const second = buildDemoKit(lead(), root);
  assert.equal(second.reused, true);
  assert.equal(second.port, first.port);
  assert.equal(readdirSync(root).filter((f) => f.startsWith('kapihan')).length, 1);
});

test('the slug on the lead wins over one derived from the name', () => {
  assert.equal(demoSlugFor(lead({ demo_slug: 'kapihan-qc' })), 'kapihan-qc');
  assert.equal(demoSlugFor(lead()), 'kapihan-sa-kanto');
});

test('recordings go into the demo\'s public/demo folder, so the next deploy hosts them', () => {
  assert.equal(recordingDir('/w', 'kuro'), join('/w', 'kuro', 'public', 'demo'));
  assert.equal(suggestedVideoUrl('https://kuro.vercel.app/', 'kuro'), 'https://kuro.vercel.app/demo/kuro-16x9.mp4');
  assert.equal(isRecorded(mkdtempSync(join(tmpdir(), 'kit-')), 'kuro'), false);
});
