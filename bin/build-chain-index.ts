#!/usr/bin/env tsx
/**
 * Build config/chain-index.json - the generated chain filter.
 *
 * Counts how many Metro Manila locations share each normalized business
 * name. A hand-written denylist was tested against real data and failed:
 * 107 names with 5+ locations carry no OSM `brand` tag at all (Hap Chan 27,
 * Tapa King 24, Gerry's Grill 21, Serenitea 20). Counting catches them;
 * a list does not.
 *
 * Run quarterly.  npm run chain-index [-- --phase 2]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  loadAreas, loadCategories, categoryKeysForPhase, configPath, dataPath,
  type ChainIndex,
} from '../src/config.ts';
import { buildCategoryQuery, runOverpass, type OsmElement } from '../src/overpass.ts';
import { normalizeName, isCountableName } from '../src/normalize.ts';
import { args, val } from '../src/cli-args.ts';

const phase = Number(val('--phase')) || 2; // index all categories by default
const keepRaw = args.includes('--keep-raw');

const areas = loadAreas();
const categories = loadCategories();
const keys = categoryKeysForPhase(categories, phase);

console.log(`\nChain index - ${areas.chainIndexLabel}`);
console.log(`  bbox:       ${areas.chainIndexBbox.join(', ')}`);
console.log(`  categories: ${keys.length} (phase <= ${phase})`);

const query = buildCategoryQuery(areas.chainIndexBbox, keys, { timeout: 240 });
const started = Date.now();
const res = await runOverpass(query, { onAttempt: (m) => console.log(m) });
console.log(`  fetched ${res.elements.length} elements in ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (keepRaw) {
  mkdirSync(dataPath('raw'), { recursive: true });
  writeFileSync(dataPath('raw/chain-index-source.json'), JSON.stringify(res));
  console.log('  raw response cached to data/raw/chain-index-source.json');
}

const isBranded = (el: OsmElement) =>
  Boolean(el.tags?.brand || el.tags?.['brand:wikidata'] || el.tags?.operator || el.tags?.wikidata);

const named = res.elements.filter((e) => e.tags?.name);
const groups = new Map<string, { count: number; branded: number; examples: Set<string> }>();

for (const el of named) {
  const key = normalizeName(el.tags!.name!);
  if (!isCountableName(key)) continue;
  const g = groups.get(key) ?? { count: 0, branded: 0, examples: new Set<string>() };
  g.count++;
  if (isBranded(el)) g.branded++;
  if (g.examples.size < 3) g.examples.add(el.tags!.name!);
  groups.set(key, g);
}

// Only names with 2+ locations are stored. Absent => 1 => independent.
const counts: Record<string, number> = {};
const examples: Record<string, string[]> = {};
for (const [name, g] of groups) {
  if (g.count < 2) continue;
  counts[name] = g.count;
  examples[name] = [...g.examples];
}

const index: ChainIndex = {
  generatedAt: new Date().toISOString(),
  bbox: areas.chainIndexBbox,
  label: areas.chainIndexLabel,
  totalPois: named.length,
  distinctNames: groups.size,
  counts,
  examples,
};

writeFileSync(configPath('chain-index.json'), JSON.stringify(index, null, 2) + '\n');

const cutoff = categories.sme.chainCutoff;
const buckets = { one: 0, sweet: 0, regional: 0, chain: 0 };
for (const g of groups.values()) {
  if (g.count === 1) buckets.one++;
  else if (g.count <= 4) buckets.sweet++;
  else if (g.count <= 9) buckets.regional++;
  else buckets.chain++;
}

console.log(`\n  named POIs:       ${named.length}`);
console.log(`  distinct names:   ${groups.size}`);
console.log(`  1 location:       ${buckets.one}  (independents)`);
console.log(`  2-4 locations:    ${buckets.sweet}  <- SME sweet spot, kept`);
console.log(`  5-9 locations:    ${buckets.regional}  (dropped, cutoff ${cutoff})`);
console.log(`  10+ locations:    ${buckets.chain}  (dropped)`);

const untagged = [...groups.entries()]
  .filter(([, g]) => g.count >= cutoff && g.branded === 0)
  .sort((a, b) => b[1].count - a[1].count);
console.log(`\n  chains with NO brand tag (a denylist would miss these): ${untagged.length}`);
for (const [name, g] of untagged.slice(0, 10)) {
  console.log(`    ${String(g.count).padStart(3)}x  ${name}`);
}
console.log(`\n  wrote ${Object.keys(counts).length} entries to config/chain-index.json\n`);
