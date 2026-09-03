#!/usr/bin/env tsx
/**
 * Confirm that drafts were sent by hand, and start the follow-up clock.
 *
 *   npm run sent -- --area katipunan --lead test-cafe --lead node/123
 *   npm run sent -- --area katipunan --all
 *   npm run sent -- --area katipunan --all --dry-run
 *
 * `npm run draft` leaves every lead at status `drafted`: a file exists, nobody
 * has pressed Send. This is the only place the pipeline records real contact,
 * because a human is the only thing in this system that can send a message.
 *
 * Thin wrapper over src/mark-sent.ts.
 */
import { openStore } from '../src/store.ts';
import { loadAreas } from '../src/config.ts';
import { today } from '../src/draft-file.ts';
import { planSent, sentPatch } from '../src/mark-sent.ts';

const args = process.argv.slice(2);
const val = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

/** --lead is repeatable: every value that follows one. */
const ids = args.flatMap((a, i) => (a === '--lead' && args[i + 1] ? [args[i + 1]!] : []));
const areaKey = val('--area');
const all = args.includes('--all');
const dryRun = args.includes('--dry-run');
const areas = loadAreas();

const usage = `
Usage: npm run sent -- [--area <name>] (--lead <id-or-slug> ... | --all) [--dry-run]

  --lead   lead_id or the draft filename slug, repeatable
  --all    every drafted lead in the area (use after sending the whole batch)
  areas:   ${Object.keys(areas.areas).join(', ')}
`;

if (areaKey && !areas.areas[areaKey]) {
  console.error(`\nUnknown area "${areaKey}".${usage}`);
  process.exit(1);
}
// One of the two is required: marking a business as contacted is not something
// that should ever happen because a flag was left off.
if (!all && ids.length === 0) {
  console.error(`\nName the leads you actually sent, or pass --all.${usage}`);
  process.exit(1);
}

const store = openStore();
const now = today();
const plan = planSent(await store.all(), { area: areaKey, ids, all });

const label = areaKey ? areas.areas[areaKey]!.label : 'all areas';
console.log(`\nMarking sent in ${label}${dryRun ? '  [DRY RUN]' : ''}   store: ${store.kind}\n`);

for (const id of plan.unmatched) {
  console.log(`  ? ${id.padEnd(34)} no drafted lead by that id or slug`);
}
for (const l of plan.suppressed) {
  console.log(`  - ${l.name.slice(0, 34).padEnd(34)} do_not_contact - skipped`);
}

if (plan.chosen.length === 0) {
  console.error('\nNothing to mark. Run `npm run draft` first, or check the ids.\n');
  process.exit(1);
}

for (const lead of plan.chosen) {
  const patch = sentPatch(lead, now);
  const next = patch.next_action_date ? `follow up ${patch.next_action_date}` : 'sequence finished';
  console.log(`  ${dryRun ? 'would mark' : 'marked'} ${lead.name.slice(0, 30).padEnd(31)} -> ${patch.status}, ${next}`);
  if (!dryRun) await store.update(lead.lead_id, patch);
}

console.log(`\n  ${dryRun ? 'would update' : 'updated'} ${plan.chosen.length} lead(s).`);
console.log('  Follow-ups become due on their next_action_date - run `npm run draft` then.\n');
