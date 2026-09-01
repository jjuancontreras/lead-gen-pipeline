#!/usr/bin/env tsx
/**
 * Sweep an area for SME leads and write them to the store.
 *
 *   npm run source -- --area katipunan [--phase 1] [--dry-run] [--limit N]
 *
 * OSM can roster leads but cannot qualify them: only 28 of 1,212 Katipunan
 * businesses carry a `website` tag, and Jollibee and KFC both come back with
 * none. Everything written here is `status: sourced` and unverified.
 */
import {
  loadAreas, loadCategories, loadManualChains, loadChainIndex,
  categoryKeysForPhase,
} from '../src/config.ts';
import { buildCategoryQuery, runOverpass, elementId, elementLatLon } from '../src/overpass.ts';
import { applyCeiling, stage1Score, chainLocations, categoryKeyOf, type RejectReason } from '../src/sme.ts';
import { emptyLead, type Lead } from '../src/lead.ts';
import { openStore } from '../src/store.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const val = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const areaKey = val('--area');
const phase = Number(val('--phase')) || 1;
const dryRun = flag('--dry-run');
const limit = Number(val('--limit')) || Infinity;

const areas = loadAreas();
if (!areaKey || !areas.areas[areaKey]) {
  console.error(`\nUsage: npm run source -- --area <name> [--phase 1|2] [--dry-run]`);
  console.error(`Known areas: ${Object.keys(areas.areas).join(', ') || '(none)'}\n`);
  process.exit(1);
}

const area = areas.areas[areaKey]!;
const config = loadCategories();
const manual = loadManualChains().denylist;
const index = loadChainIndex();
if (!index) {
  console.error('\nNo chain-index.json. Run `npm run chain-index` first - without it');
  console.error('every chain looks like an independent.\n');
  process.exit(1);
}

const keys = categoryKeysForPhase(config, phase);
console.log(`\nSourcing ${area.label}${dryRun ? '  [DRY RUN]' : ''}`);
console.log(`  bbox: ${area.bbox.join(', ')}   categories: ${keys.length} (phase <= ${phase})`);

const query = buildCategoryQuery(area.bbox, keys, { timeout: 120, withCenter: true });
const res = await runOverpass(query, { onAttempt: (m) => console.log(m) });

const named = res.elements.filter((e) => e.tags?.name);
const rejects: Record<string, number> = {};
const kept: Lead[] = [];

for (const el of named) {
  const verdict = applyCeiling({ element: el, index, config, manualDenylist: manual, maxPhase: phase });
  if (!verdict.keep) {
    const r = verdict.reason as RejectReason;
    rejects[r] = (rejects[r] ?? 0) + 1;
    continue;
  }
  const tags = el.tags!;
  const name = tags.name!;
  const locations = chainLocations(name, index);
  const catKey = categoryKeyOf(tags, config.categories)!;
  const pos = elementLatLon(el);

  const lead = emptyLead();
  lead.lead_id = elementId(el);
  lead.name = name;
  lead.category = config.categories[catKey]!.label;
  lead.area = areaKey;
  lead.lat = pos ? pos.lat.toFixed(6) : '';
  lead.lng = pos ? pos.lon.toFixed(6) : '';
  lead.maps_url =
    'https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent(`${name} ${area.label}`);
  lead.osm_score = String(stage1Score(el, config, locations));
  lead.has_hours = tags.opening_hours ? 'yes' : 'no';
  lead.has_address = tags['addr:street'] ? 'yes' : 'no';
  lead.cuisine = tags.cuisine ?? '';
  lead.chain_locations = String(locations);
  lead.phone = tags.phone ?? tags['contact:phone'] ?? '';
  lead.has_website = 'unknown';
  // An OSM website tag is a hint to check, never a verdict - see header.
  lead.website_url = tags.website ?? tags['contact:website'] ?? tags.url ?? '';
  lead.instagram = tags['contact:instagram'] ?? '';
  lead.facebook = tags['contact:facebook'] ?? '';
  lead.email = tags.email ?? tags['contact:email'] ?? '';
  kept.push(lead);
}

kept.sort((a, b) => Number(b.osm_score) - Number(a.osm_score));
const selected = kept.slice(0, limit);

console.log(`\n  named businesses:   ${named.length}`);
for (const [reason, n] of Object.entries(rejects).sort((a, b) => b[1] - a[1])) {
  console.log(`    dropped ${reason.padEnd(16)} ${String(n).padStart(5)}`);
}
console.log(`  survived SME band:  ${kept.length}`);
if (selected.length !== kept.length) console.log(`  limited to:         ${selected.length}`);

console.log(`\n  top 10 by stage-1 score:`);
for (const l of selected.slice(0, 10)) {
  const branches = Number(l.chain_locations) > 1 ? ` [${l.chain_locations} branches]` : '';
  console.log(`    ${String(l.osm_score).padStart(3)}  ${l.name.slice(0, 38).padEnd(39)} ${l.category}${branches}`);
}

if (dryRun) {
  console.log(`\n  DRY RUN - nothing written.\n`);
} else {
  const store = openStore();
  const { added, skipped } = await store.upsert(selected);
  console.log(`\n  store: ${store.kind} (${store.location})`);
  console.log(`  added ${added} new, skipped ${skipped} already present.\n`);
}
