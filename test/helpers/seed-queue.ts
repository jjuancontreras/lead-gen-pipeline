/**
 * A throwaway JSON store with a fictional lead waiting in every Work Queue
 * group. Used by the Work Queue tests; also handy for a look at the page:
 *
 *   npx tsx test/helpers/seed-queue.ts <data dir>
 */
import { join } from 'node:path';
import { JsonStore } from '../../src/store.ts';
import { emptyLead, type Lead } from '../../src/lead.ts';
import { loadFixtureLeads } from './fixtures.ts';

const extra = (over: Partial<Lead>): Lead => ({
  ...emptyLead(), category: 'Restaurant', area: 'katipunan', tier: 'B', has_website: 'no', osm_score: '12', ...over,
});

/** Lead ids by the group they start in. */
export const SEEDED = {
  choose: 'fixture/1',        // Kapihan sa Kanto - verified tier A
  verify: 'fixture/2',        // Lola Nena's Kusina - needs manual verification
  build: 'fixture/3',         // Cafe Nora & Sons Bakery - queued for a demo
  send: 'fixture/4',
  followup: 'fixture/5',
  conversations: 'fixture/6',
  otherArea: 'fixture/7',
} as const;

export function seedLeads(today: string): Lead[] {
  const [kapihan, lola, nora] = loadFixtureLeads();
  return [
    kapihan!,
    { ...lola!, status: 'needs_manual', tier: '', has_website: 'unknown', email: '', facebook: '' },
    { ...nora!, status: 'demo_queued' },
    extra({ lead_id: SEEDED.send, name: 'Tindahan ni Aling Rosa', status: 'drafted', email: 'rosa@tindahan.example.com' }),
    extra({ lead_id: SEEDED.followup, name: 'Bike Kusina', status: 'tier1_sent', email: 'hi@bikekusina.example.com',
      first_contacted_at: '2026-09-18', last_contacted_at: '2026-09-18', next_action_date: today }),
    extra({ lead_id: SEEDED.conversations, name: 'Pansitan sa Kanto', status: 'replied', email: 'pansit@kanto.example.org' }),
    extra({ lead_id: SEEDED.otherArea, name: 'Shaw Silog House', area: 'shaw-blvd-mandaluyong', status: 'needs_manual', tier: '' }),
    // Counted, not listed: the queue shows "N more not verified yet".
    extra({ lead_id: 'fixture/8', name: 'Unverified Carinderia', status: 'sourced', tier: '' }),
  ];
}

export async function seedQueue(dataDir: string, today: string): Promise<void> {
  await new JsonStore(join(dataDir, 'leads.json')).upsert(seedLeads(today));
}

if (process.argv[1]?.endsWith('seed-queue.ts') && process.argv[2]) {
  const { today } = await import('../../src/dates.ts');
  await seedQueue(process.argv[2], today());
  console.log(`seeded ${process.argv[2]}`);
}
