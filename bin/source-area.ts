#!/usr/bin/env tsx
/**
 * Sweep an area for SME leads.
 *   npm run source -- --area katipunan [--phase 1] [--dry-run] [--limit N]
 *
 * Thin wrapper over src/stages/source.ts so the CLI and the campaign
 * orchestrator share one implementation.
 */
import { loadAreas } from '../src/config.ts';
import { sourceArea } from '../src/stages/source.ts';
import { args, val, intFlag, optionalIntFlag } from '../src/cli-args.ts';

const areaKey = val('--area');
const areas = loadAreas();

if (!areaKey || !areas.areas[areaKey]) {
  console.error(`\nUsage: npm run source -- --area <name> [--phase 1|2] [--dry-run]`);
  console.error(`Known areas: ${Object.keys(areas.areas).join(', ') || '(none)'}\n`);
  process.exit(1);
}

const area = areas.areas[areaKey]!;
const dryRun = args.includes('--dry-run');
console.log(`\nSourcing ${area.label}${dryRun ? '  [DRY RUN]' : ''}`);

const r = await sourceArea({
  area: areaKey,
  phase: intFlag('--phase', 1),
  limit: optionalIntFlag('--limit'),
  dryRun,
  log: (m) => console.log(m),
});

console.log(`\n  named businesses:   ${r.named}`);
for (const [reason, n] of Object.entries(r.rejects).sort((a, b) => b[1] - a[1])) {
  console.log(`    dropped ${reason.padEnd(16)} ${String(n).padStart(5)}`);
}
console.log(`  survived SME band:  ${r.kept.length}`);
console.log(`\n  top 10 by stage-1 score:`);
for (const l of r.kept.slice(0, 10)) {
  const branches = Number(l.chain_locations) > 1 ? ` [${l.chain_locations} branches]` : '';
  console.log(`    ${String(l.osm_score).padStart(3)}  ${l.name.slice(0, 38).padEnd(39)} ${l.category}${branches}`);
}
console.log(dryRun ? `\n  DRY RUN - nothing written.\n` : `\n  added ${r.added} new, skipped ${r.skipped} already present.\n`);
