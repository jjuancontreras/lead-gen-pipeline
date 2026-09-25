/**
 * The fictional businesses in test/fixtures/businesses.json, as leads.
 * Validated, so a typo in a fixture column fails loudly instead of quietly
 * testing the wrong thing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { COLUMNS, emptyLead, type Lead } from '../../src/lead.ts';

const LEAD_KEYS = new Set<string>(COLUMNS);

const FixtureFile = z.object({
  _note: z.string().optional(),
  businesses: z.array(z.object({
    lead_id: z.string().min(1),
    name: z.string().trim().min(1),
    category: z.string().trim().min(1),
    area: z.string().min(1),
  }).catchall(z.string()).superRefine((b, ctx) => {
    for (const key of Object.keys(b)) {
      if (!LEAD_KEYS.has(key)) ctx.addIssue({ code: 'custom', path: [key], message: 'not a lead column' });
    }
  })).min(1),
});

export const FIXTURES = resolve(import.meta.dirname, '..', 'fixtures', 'businesses.json');

export function loadFixtureLeads(path: string = FIXTURES): Lead[] {
  const parsed = FixtureFile.parse(JSON.parse(readFileSync(path, 'utf8')));
  return parsed.businesses.map((b) => ({ ...emptyLead(), ...b }) as Lead);
}
