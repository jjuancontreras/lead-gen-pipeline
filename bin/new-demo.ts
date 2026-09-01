#!/usr/bin/env tsx
/**
 * Scaffold one demo site.
 *   npm run new-demo -- --slug kuro-cafe [--lead node/123456] [--force]
 *
 * Thin wrapper over src/scaffold.ts, shared with the campaign orchestrator.
 */
import { scaffoldDemo } from '../src/scaffold.ts';
import { openStore } from '../src/store.ts';

const args = process.argv.slice(2);
const val = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const slug = val('--slug');
const leadId = val('--lead');

if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error('\nUsage: npm run new-demo -- --slug <kebab-case-name> [--lead node/123]\n');
  process.exit(1);
}

const store = openStore();
const lead = leadId ? (await store.all()).find((l) => l.lead_id === leadId) : undefined;
if (leadId && !lead) console.warn(`  ! lead ${leadId} not found - seeding placeholders only`);

const r = scaffoldDemo({ slug, lead, force: args.includes('--force') });
if (lead) await store.update(lead.lead_id, { demo_slug: r.slug, status: 'demo_built' });

console.log(`\n  scaffolded ${lead?.name ?? slug}`);
console.log(`    path:  ${r.path}`);
console.log(`    port:  ${r.port}  (registered in .claude/launch.json)`);
if (lead) console.log(`    lead:  ${lead.lead_id}  tier ${lead.tier || '-'}`);
console.log(`\n  next:`);
console.log(`    cd ${slug} && npm install`);
console.log(`    derive the visual system into DESIGN.md, then fill globals.css`);
console.log(`    the template palette is neutral grey on purpose - replace it\n`);
