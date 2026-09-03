#!/usr/bin/env tsx
/**
 * Draft outreach for an area. NOTHING IS SENT.
 *
 *   npm run draft -- --area katipunan [--template email-first]
 *                    [--limit 20] [--tier B] [--dry-run]
 *
 * Email becomes a Gmail draft when GMAIL_TOKEN_PATH is set, and a file in
 * data/drafts/ when it is not. Instagram, Messenger and TikTok always become
 * files - you paste those by hand, every time.
 *
 * Thin wrapper over src/stages/outreach.ts.
 */
import { loadAreas } from '../src/config.ts';
import { credentialAvailable } from '../src/campaign-stages.ts';
import { availableTemplates } from '../src/outreach.ts';
import { draftOutreach, DEFAULT_OUTREACH_LIMIT } from '../src/stages/outreach.ts';
import type { Tier } from '../src/lead.ts';

const args = process.argv.slice(2);
const val = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const areaKey = val('--area');
const areas = loadAreas();

const usage = `
Usage: npm run draft -- --area <name> [--template <name>] [--limit 20] [--tier B] [--dry-run]

  areas:      ${Object.keys(areas.areas).join(', ')}
  templates:  ${availableTemplates().join(', ')}
              (omit --template to pick first contact by channel)
`;

if (!areaKey || !areas.areas[areaKey]) {
  console.error(usage);
  process.exit(1);
}

const template = val('--template');
if (template && !availableTemplates().includes(template)) {
  console.error(`\nUnknown template "${template}".${usage}`);
  process.exit(1);
}

const dryRun = args.includes('--dry-run');
// B is the volume tier: A-tier gets a demo built before anyone contacts them.
const tiers = (val('--tier') ?? 'B').split(',').map((t) => t.trim().toUpperCase()) as Tier[];
const label = areas.areas[areaKey]!.label;
const gmailTokenPath = process.env.GMAIL_TOKEN_PATH;
const gmailReady = credentialAvailable('gmail');

console.log(`\nDrafting outreach for ${label}${dryRun ? '  [DRY RUN]' : ''}`);
console.log(`  tier ${tiers.join('/')}   template ${template ?? 'auto (by channel)'}`);
if (gmailReady) {
  console.log('  email -> Gmail drafts (token is usable)');
} else if (gmailTokenPath) {
  console.log('  email -> data/drafts/ files (GMAIL_TOKEN_PATH set but token unusable - missing refresh_token)');
} else {
  console.log('  email -> data/drafts/ files (no GMAIL_TOKEN_PATH yet)');
}
console.log();

const r = await draftOutreach({
  area: areaKey,
  limit: Number(val('--limit')) || DEFAULT_OUTREACH_LIMIT,
  template, tiers, dryRun,
  log: (m) => console.log('  ' + m),
});

// A withdrawal is real work even when the pool is empty - an opt-out is often
// the very reason it is empty - so report it before calling the run a no-op.
if (r.withdrawn.length) {
  console.log(`  withdrew ${r.withdrawn.length} draft(s) - lead flagged do_not_contact:`);
  for (const w of r.withdrawn) console.log(`    ${w.name.slice(0, 34).padEnd(35)} ${w.file}`);
}

if (r.attempted === 0) {
  const why = template
    ? `Nobody is due for "${template}" in ${label}.`
    : `No uncontacted tier-${tiers.join('/')} leads in ${label}. Run verify first.`;
  // Exit 0 when something was withdrawn: the run did its job, and a non-zero
  // exit would fail the campaign for a correct outcome.
  if (r.withdrawn.length) {
    console.log(`\n${why}\n`);
    process.exit(0);
  }
  console.error(`\n${why}\n`);
  process.exit(1);
}

console.log(`\n  drafted ${r.drafted}/${r.attempted}`);
if (r.gmailDrafts) console.log(`  gmail drafts: ${r.gmailDrafts}  (in Gmail, unsent)`);
if (r.files.length) console.log(`  files:        ${r.files.length} in data/drafts/`);
if (r.indexPath) console.log(`  start here:   data/drafts/INDEX.md`);
if (!r.gmailReady) {
  if (gmailTokenPath) {
    console.log('\n  ! Token is set but unusable (missing refresh_token), so email went to files.');
  } else {
    console.log('\n  ! GMAIL_TOKEN_PATH is not set, so email went to files too.');
  }
  console.log('    Point it at an OAuth token JSON to get real Gmail drafts.');
}
if (r.skipped.length) {
  console.log(`\n  ${r.skipped.length} skipped:`);
  for (const { lead, reason } of r.skipped.slice(0, 10)) {
    console.log(`    ${lead.name.slice(0, 34).padEnd(35)} ${reason}`);
  }
}
console.log('\n  NOTHING WAS SENT. Read each draft, then send it yourself.\n');
