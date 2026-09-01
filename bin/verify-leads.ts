#!/usr/bin/env tsx
/**
 * Automated verification: resolve each shortlisted lead on Google Maps,
 * classify whether it has a real standalone website, and tier it.
 *
 *   npm run verify -- --area katipunan [--limit 20] [--dry-run] [--headed]
 *
 * Anything that cannot be resolved confidently is left for the manual
 * worklist rather than written as fact. Pacing is deliberately slow: this is
 * low-volume prospecting, and hammering Maps both degrades results and is
 * not the kind of traffic we want to generate.
 */
import { launch, fetchPlace, jitter } from '../src/fetcher.ts';
import { classifyWebsite } from '../src/website.ts';
import { stage2 } from '../src/score.ts';
import { openStore } from '../src/store.ts';
import { loadCategories, loadAreas } from '../src/config.ts';
import type { Lead } from '../src/lead.ts';

const args = process.argv.slice(2);
const val = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const areaKey = val('--area');
const limit = Number(val('--limit')) || 20;
const dryRun = args.includes('--dry-run');
const headed = args.includes('--headed');
const paceMs = Number(val('--pace')) || 12_000;

if (!areaKey) {
  console.error('Usage: npm run verify -- --area <name> [--limit 20] [--dry-run]');
  process.exit(1);
}

const store = openStore();
const config = loadCategories();
const areas = loadAreas();
const areaLabel = areas.areas[areaKey]?.label ?? areaKey;

const pool = (await store.all())
  .filter((l) => l.area === areaKey && (l.status === 'shortlisted' || l.status === 'sourced'))
  .sort((a, b) => Number(b.osm_score) - Number(a.osm_score))
  .slice(0, limit);

if (pool.length === 0) {
  console.error(`No shortlisted leads for "${areaKey}". Run source/worklist first.`);
  process.exit(1);
}

console.log(`\nVerifying ${pool.length} leads in ${areaLabel}${dryRun ? '  [DRY RUN]' : ''}`);
console.log(`  pacing ~${(paceMs / 1000).toFixed(0)}s between lookups\n`);

const browser = await launch(!headed);
const tallyTier: Record<string, number> = {};
const tallyStatus: Record<string, number> = {};
const needsManual: { lead: Lead; reason: string }[] = [];

try {
  for (const [i, lead] of pool.entries()) {
    const n = `${i + 1}/${pool.length}`;
    const res = await fetchPlace(browser, { name: lead.name, area: areaLabel });

    if (!res.ok) {
      needsManual.push({ lead, reason: `${res.reason}${res.detail ? ' - ' + res.detail : ''}` });
      console.log(`  ${n} ${lead.name.slice(0, 34).padEnd(35)} -> manual (${res.reason})`);
    } else {
      const f = res.facts;
      const verdict = classifyWebsite(f.websiteUrl);
      const patch: Partial<Lead> = {
        website_url: f.websiteUrl ?? '',
        website_kind: verdict.kind,
        has_website: verdict.isStandalone ? 'yes' : 'no',
        verify_method: 'auto',
        verify_confidence: res.confidence,
        phone: f.phone ?? lead.phone,
        rating: f.rating ?? '',
        review_count: f.reviewCount ?? '',
      };
      const scored = stage2({ ...lead, ...patch } as Lead, config);
      patch.tier = scored.tier;
      patch.status = scored.status;
      patch.notes = scored.reasons.join('; ');

      if (!dryRun) await store.update(lead.lead_id, patch);
      tallyTier[scored.tier || '-'] = (tallyTier[scored.tier || '-'] ?? 0) + 1;
      tallyStatus[scored.status] = (tallyStatus[scored.status] ?? 0) + 1;

      const kind = verdict.kind === 'none' ? 'no web presence' : verdict.kind;
      console.log(
        `  ${n} ${lead.name.slice(0, 34).padEnd(35)} ${String(kind).padEnd(14)} ` +
        `${(scored.tier || '-').padEnd(2)} ${scored.status}`,
      );
    }
    if (i < pool.length - 1) await jitter(paceMs);
  }
} finally {
  await browser.close();
}

console.log(`\n  resolved automatically: ${pool.length - needsManual.length}/${pool.length}`);
const tiers = (['A', 'B', 'C'] as const).map((t) => `${t}:${tallyTier[t] ?? 0}`).join('  ');
console.log(`  tiers   ${tiers}`);
for (const [k, v] of Object.entries(tallyStatus)) console.log(`  status  ${k}: ${v}`);

if (needsManual.length) {
  console.log(`\n  ${needsManual.length} need manual verification:`);
  for (const { lead, reason } of needsManual.slice(0, 10)) {
    console.log(`    ${lead.name.slice(0, 34).padEnd(35)} ${reason}`);
  }
  console.log(`\n  -> npm run worklist -- --area ${areaKey}`);
}
if (dryRun) console.log('\n  DRY RUN - nothing written.');
console.log();
