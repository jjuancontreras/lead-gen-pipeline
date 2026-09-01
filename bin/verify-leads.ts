#!/usr/bin/env tsx
/**
 * Verify shortlisted leads against Google Maps.
 *   npm run verify -- --area katipunan [--limit 20] [--dry-run] [--headed]
 *
 * Thin wrapper over src/stages/verify.ts.
 */
import { loadAreas } from '../src/config.ts';
import { verifyLeads } from '../src/stages/verify.ts';

const args = process.argv.slice(2);
const val = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const areaKey = val('--area');
const areas = loadAreas();

if (!areaKey || !areas.areas[areaKey]) {
  console.error('\nUsage: npm run verify -- --area <name> [--limit 20] [--dry-run]\n');
  process.exit(1);
}

const label = areas.areas[areaKey]!.label;
const dryRun = args.includes('--dry-run');
const pace = Number(val('--pace')) || 12_000;
console.log(`\nVerifying ${label}${dryRun ? '  [DRY RUN]' : ''}   pacing ~${(pace / 1000).toFixed(0)}s\n`);

const r = await verifyLeads({
  area: areaKey, areaLabel: label,
  limit: Number(val('--limit')) || 20,
  dryRun, paceMs: pace, headed: args.includes('--headed'),
  log: (m) => console.log('  ' + m),
});

if (r.attempted === 0) { console.error('No shortlisted leads. Run source first.\n'); process.exit(1); }
console.log(`\n  resolved automatically: ${r.resolved}/${r.attempted}`);
console.log(`  tiers   ` + (['A', 'B', 'C'] as const).map((t) => `${t}:${r.tiers[t] ?? 0}`).join('  '));
for (const [k, v] of Object.entries(r.statuses)) console.log(`  status  ${k}: ${v}`);
if (r.handoff.length) {
  console.log(`\n  ${r.handoff.length} need manual verification:`);
  for (const { lead, reason } of r.handoff.slice(0, 10)) {
    console.log(`    ${lead.name.slice(0, 34).padEnd(35)} ${reason}`);
  }
  console.log(`\n  -> npm run worklist -- --area ${areaKey}`);
}
console.log();
