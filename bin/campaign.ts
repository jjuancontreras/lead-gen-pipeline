#!/usr/bin/env tsx
/**
 * THE ENTRY POINT. Pick an area, run everything.
 *
 *   npm run campaign                      interactive area picker
 *   npm run campaign -- --area katipunan  non-interactive
 *   npm run campaign -- --area x --dry-run
 *   npm run campaign -- --area x --stage verify
 *
 * Runs unattended and then stops at the handoff, because four things
 * genuinely cannot be automated: choosing and designing demos, sending, and
 * leads the browser could not resolve.
 */
import { createInterface } from 'node:readline/promises';
import { writeFileSync } from 'node:fs';
import { loadAreas, loadChainIndex, dataPath } from '../src/config.ts';
import { DEFAULT_CAPS, type StageContext, type Caps } from '../src/campaign-stages.ts';
import { STAGES } from '../src/stages/index.ts';
import type { Lead } from '../src/lead.ts';
import { today } from '../src/dates.ts';
import { args, val, intFlag } from '../src/cli-args.ts';

const dryRun = args.includes('--dry-run');
const onlyStage = val('--stage');

const areas = loadAreas();
const areaKeys = Object.keys(areas.areas);

async function pickArea(): Promise<string> {
  const given = val('--area');
  if (given) {
    if (!areas.areas[given]) {
      console.error(`\nUnknown area "${given}". Known: ${areaKeys.join(', ')}\n`);
      process.exit(1);
    }
    return given;
  }
  if (areaKeys.length === 0) {
    console.error('\nNo areas configured. Add one to config/areas.json.\n');
    process.exit(1);
  }
  console.log('\n  Pick an area:\n');
  areaKeys.forEach((k, i) => {
    console.log(`    ${String(i + 1).padStart(2)}. ${areas.areas[k]!.label}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\n  number > ')).trim();
  rl.close();
  const idx = Number(answer) - 1;
  const key = areaKeys[idx];
  if (!key) { console.error('  no such option\n'); process.exit(1); }
  return key;
}

const area = await pickArea();
const areaLabel = areas.areas[area]!.label;

const caps: Caps = {
  ...DEFAULT_CAPS,
  maxVerify: intFlag('--max-verify', DEFAULT_CAPS.maxVerify),
};

// A stale or missing chain index means every chain looks like an independent.
const index = loadChainIndex();
if (!index) {
  console.error('\n  No chain-index.json. Run `npm run chain-index` first.\n');
  process.exit(1);
}
const ageDays = (Date.now() - Date.parse(index.generatedAt)) / 86_400_000;
if (ageDays > 90) {
  console.log(`\n  ! chain index is ${Math.round(ageDays)} days old - consider \`npm run chain-index\``);
}

console.log(`\n  Campaign: ${areaLabel}${dryRun ? '   [DRY RUN - nothing will be written]' : ''}`);
console.log(`  caps: ${caps.maxVerify} verifications per run\n`);

const toRun = onlyStage ? STAGES.filter((s) => s.name === onlyStage) : STAGES;
if (toRun.length === 0) {
  console.error(`  Unknown stage "${onlyStage}". Known: ${STAGES.map((s) => s.name).join(', ')}\n`);
  process.exit(1);
}

const ctx: StageContext = {
  area, areaLabel, dryRun, caps,
  log: (m) => console.log(`      ${m}`),
};

const handoff: { lead: Lead; reason: string }[] = [];
const briefLines: string[] = [];
const failedStages: string[] = [];

for (const stage of toRun) {
  console.log(`  > ${stage.name}  ${stage.description}`);
  try {
    const res = await stage.run(ctx);
    console.log(`      ${res.summary}`);
    briefLines.push(`- ${stage.name}: ${res.summary}`);
    if (res.handoff) handoff.push(...res.handoff);
  } catch (err) {
    // One failing stage must not lose the work the earlier stages did.
    failedStages.push(stage.name);
    console.log(`      FAILED: ${(err as Error).message}`);
    briefLines.push(`- ${stage.name}: FAILED - ${(err as Error).message}`);
  }
}

// ---- handoff brief ---------------------------------------------------------
const runDate = today();

const lines = [
  `# Campaign brief - ${areaLabel}`,
  ``,
  `Run ${runDate}${dryRun ? '  (dry run)' : ''}`,
  ``,
  `## What ran`,
  ``,
  ...briefLines,
  ``,
];

if (handoff.length) {
  lines.push(`## Needs you (${handoff.length})`, ``);
  for (const h of handoff) {
    lines.push(`- **${h.lead.name}** — ${h.reason}`);
  }
  lines.push(``, `Work these in a browser session:`, '```bash',
    `npm run worklist -- --area ${area}`, '```', ``);
}

lines.push(
  `## Why this stops here`,
  ``,
  `Four things are deliberately not automated:`,
  ``,
  `- **choosing who gets a demo** — a demo is 3-5 hours; pick in the Work Queue`,
  `- **designing the demo** — that is a Claude Code session, not a script`,
  `- **sending anything** — every channel drafts only, you press send`,
  `- **leads the browser could not resolve** — guessing would attach the`,
  `  wrong business's details to a lead`,
  ``,
);

const briefPath = dataPath(`campaign-brief-${area}-${runDate}.md`);
if (!dryRun) writeFileSync(briefPath, lines.join('\n'));

console.log(`\n  ${handoff.length} leads need manual attention`);
console.log(dryRun ? '  DRY RUN - no brief written\n' : `  brief: ${briefPath}\n`);

if (failedStages.length > 0) {
  console.log(`  FAILED: ${failedStages.join(', ')}`);
  process.exit(1);
}
