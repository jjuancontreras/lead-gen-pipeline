#!/usr/bin/env tsx
/**
 * Generate a verification worklist.
 *
 *   npm run worklist -- --area katipunan [--limit 60]
 *
 * Every lead gets pre-built URLs so a browser session is mechanical rather
 * than exploratory. Fill the `answer` block under each lead, then run
 * `npm run worklist -- --ingest` to read the answers back into the store.
 *
 * This is the fallback path for leads automated verification cannot reach
 * (consent walls, Instagram blocks) - and the whole path until a Gemini key
 * is configured.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dataPath, loadAreas } from '../src/config.ts';
import { openStore } from '../src/store.ts';
import { manualVerifyPatch, hasAnyContact } from '../src/manual-verify.ts';
import { loadCategories } from '../src/config.ts';
import { today } from '../src/dates.ts';
import type { Lead } from '../src/lead.ts';
import { args, val, intFlag } from '../src/cli-args.ts';

const areaKey = val('--area');
const limit = intFlag('--limit', 60);
const ingest = args.includes('--ingest');

const store = openStore();
const areas = loadAreas();
const file = (a: string) => dataPath(`worklist-${a}.md`);

const q = (s: string) => encodeURIComponent(s);

function block(lead: Lead, area: string, i: number, total: number): string {
  const name = lead.name;
  const label = areas.areas[area]?.label ?? area;
  const branches = Number(lead.chain_locations) > 1
    ? ` · ${lead.chain_locations} branches` : '';
  return `
### ${i}/${total} — ${name}
\`${lead.lead_id}\` · ${lead.category}${branches} · stage-1 score ${lead.osm_score}

- [Google Maps](${lead.maps_url})
- [Web search](https://www.google.com/search?q=${q(`"${name}" ${label}`)})
- [Facebook](https://www.facebook.com/search/top?q=${q(`${name} ${label}`)})
- [Instagram](https://www.instagram.com/explore/search/keyword/?q=${q(name)})

\`\`\`yaml
id: ${lead.lead_id}
website_url:        # their site, or blank. A FB/IG/TikTok/Linktree/GrabFood
                    # link is NOT a website - paste it here anyway, it gets
                    # classified and counts strongly IN their favour.
email:              # priority 1
phone:              # priority 2
instagram:          # priority 3  (@handle)
facebook:           # priority 4  (page url or handle)
tiktok:             # priority 5  (@handle)
rating:
review_count:
ig_followers:
photo_count:        # usable photos you could build a site from
notes:
\`\`\`
`;
}

function parseBlocks(mdRaw: string): Record<string, string>[] {
  // Normalize line endings first: this file gets hand-edited on Windows,
  // where any editor may save CRLF. Matching only LF silently finds zero
  // blocks and reports 'ingested 0' as if the work had not been done.
  const md = mdRaw.replace(/\r\n/g, '\n');
  const out: Record<string, string>[] = [];
  const re = /```yaml\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const rec: Record<string, string> = {};
    for (const line of m[1]!.split('\n')) {
      const mm = line.match(/^([a-z_]+):\s*(.*)$/);
      if (!mm) continue;
      // Strip trailing comments, but never from a value containing a URL.
      let v = mm[2]!.trim();
      if (!/https?:\/\//.test(v)) v = v.replace(/\s+#.*$/, '').trim();
      rec[mm[1]!] = v;
    }
    if (rec.id) out.push(rec);
  }
  return out;
}

if (ingest) {
  if (!areaKey) { console.error('--ingest needs --area'); process.exit(1); }
  const path = file(areaKey);
  if (!existsSync(path)) { console.error(`No worklist at ${path}`); process.exit(1); }
  const records = parseBlocks(readFileSync(path, 'utf8'));
  const all = await store.all();
  const config = loadCategories();
  const tally: Record<string, number> = {};
  const tallyTier: Record<string, number> = {};
  const patches = new Map<string, Partial<Lead>>();
  let filled = 0, blank = 0;

  for (const rec of records) {
    if (!hasAnyContact(rec)) { blank++; continue; }
    // Classified and scored on ingest, so tiering is visible without a second
    // command - the same rules as the Work Queue's verify form.
    const patch = manualVerifyPatch(all.find((x) => x.lead_id === rec.id), rec, config);
    tally[patch.status!] = (tally[patch.status!] ?? 0) + 1;
    if (patch.tier) tallyTier[patch.tier] = (tallyTier[patch.tier] ?? 0) + 1;

    patches.set(rec.id!, { ...patches.get(rec.id!), ...patch });
    filled++;
  }
  await store.updateMany(patches);
  console.log(`
  ingested ${filled} verified, ${blank} left blank (still shortlisted)`);
  console.log(`  tiers   ` + (['A','B','C'] as const).map((t) => `${t}:${tallyTier[t] ?? 0}`).join('  '));
  for (const [k, v] of Object.entries(tally)) console.log(`  status  ${k}: ${v}`);
  console.log();
} else {
  if (!areaKey) { console.error('Usage: npm run worklist -- --area <name> [--limit 60]'); process.exit(1); }
  const all = await store.all();
  const pool = all
    .filter((l) => l.area === areaKey &&
      (l.status === 'sourced' || l.status === 'shortlisted' || l.status === 'needs_manual'))
    .sort((a, b) => Number(b.osm_score) - Number(a.osm_score))
    .slice(0, limit);

  if (pool.length === 0) { console.error(`No sourced leads for area "${areaKey}".`); process.exit(1); }

  const label = areas.areas[areaKey]?.label ?? areaKey;
  const header = `# Verification worklist — ${label}

${pool.length} leads, highest stage-1 score first. Generated ${today()}.

**A website means a separate standalone site.** Facebook, Instagram, TikTok,
Linktree and delivery-app listings do not count — a business with only those
is a *strong* prospect, not a rejected one.

Contact priority: **email → phone → Instagram → Facebook → TikTok.**

Fill the \`yaml\` blocks, then: \`npm run worklist -- --area ${areaKey} --ingest\`

---
`;
  const body = pool.map((l, i) => block(l, areaKey, i + 1, pool.length)).join('\n---\n');
  writeFileSync(file(areaKey), header + body);

  await store.updateMany(new Map(pool
    .filter((l) => l.status === 'sourced')
    .map((l) => [l.lead_id, { status: 'shortlisted' as const }])));
  console.log(`\n  wrote ${pool.length} leads to ${file(areaKey)}`);
  console.log(`  marked them 'shortlisted'\n`);
}
