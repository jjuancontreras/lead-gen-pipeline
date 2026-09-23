import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonStore } from '../src/store.ts';
import { emptyLead, type Lead } from '../src/lead.ts';

const lead = (id: string, over: Partial<Lead> = {}): Lead => ({ ...emptyLead(), lead_id: id, name: id, ...over });

async function storeWith(...leads: Lead[]): Promise<JsonStore> {
  const store = new JsonStore(join(mkdtempSync(join(tmpdir(), 'pipeline-json-')), 'leads.json'));
  await store.upsert(leads);
  return store;
}

test('updateMany patches every named lead and leaves the rest alone', async () => {
  const store = await storeWith(lead('node/1'), lead('node/2'), lead('node/3', { phone: '0917' }));
  await store.updateMany(new Map<string, Partial<Lead>>([
    ['node/1', { status: 'shortlisted' }],
    ['node/3', { status: 'shortlisted' }],
  ]));
  const byId = new Map((await store.all()).map((l) => [l.lead_id, l]));
  assert.equal(byId.get('node/1')!.status, 'shortlisted');
  assert.equal(byId.get('node/2')!.status, 'sourced');
  assert.equal(byId.get('node/3')!.status, 'shortlisted');
  assert.equal(byId.get('node/3')!.phone, '0917');
});

test('CRITICAL: one unknown lead leaves the file untouched', async () => {
  const store = await storeWith(lead('node/1'));
  const before = statSync(store.location).mtimeMs;
  await assert.rejects(
    store.updateMany(new Map([['node/1', { status: 'shortlisted' as const }], ['node/404', {}]])),
    /No such lead: node\/404/,
  );
  assert.equal((await store.all())[0]!.status, 'sourced');
  assert.equal(statSync(store.location).mtimeMs, before);
});

test('an empty batch writes nothing', async () => {
  const store = await storeWith(lead('node/1'));
  const before = statSync(store.location).mtimeMs;
  await store.updateMany(new Map());
  assert.equal(statSync(store.location).mtimeMs, before);
});
