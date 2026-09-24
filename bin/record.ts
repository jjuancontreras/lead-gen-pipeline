#!/usr/bin/env tsx
/**
 * Record a demo-site walkthrough.
 *
 *   npm run record -- --slug gubat [--url http://localhost:3011]
 *                     [--only 16x9|9x16] [--headed]
 *
 * Produces two MP4s because the channels differ: 1920x1080 for email and
 * 1080x1920 for Instagram/Messenger DMs. The vertical take is recorded at a
 * mobile viewport rather than cropped from the desktop one, so the site
 * renders its own mobile layout instead of being letterboxed.
 *
 * The dev server is NOT started for you - a recorder that silently boots a
 * server would leave orphaned processes behind. Start it first:
 *   npm --prefix <slug> run dev -- --port <port>
 */
import { recordDemo, VIDEO_FORMATS, type VideoFormat } from '../src/record.ts';
import { args, val, optionalIntFlag } from '../src/cli-args.ts';


const slug = val('--slug');
if (!slug) {
  console.error('\nUsage: npm run record -- --slug <slug> [--url <url>] [--only 16x9|9x16]\n');
  process.exit(1);
}

const only = val('--only') as VideoFormat | undefined;
if (only && !VIDEO_FORMATS.includes(only)) {
  console.error(`\n--only must be one of: ${VIDEO_FORMATS.join(', ')}\n`);
  process.exit(1);
}

const targetMs = optionalIntFlag('--target-ms');

try {
  const report = await recordDemo({
    slug,
    url: val('--url'),
    only,
    targetMs,
    headed: args.includes('--headed'),
    log: (m) => console.log('  ' + m),
  });

  console.log(`\n  recorded ${report.slug}`);
  console.log(`    source: ${report.url}`);
  console.log(`    output: ${report.outDir}\n`);
  for (const take of report.takes) {
    const probe = take.probe;
    console.log(`    ${take.format.padEnd(6)} ${probe.width}x${probe.height}  ` +
      `${probe.codec}/${probe.pixFmt}  ${(probe.durationMs / 1000).toFixed(1)}s  ` +
      `${(probe.bytes / 1_000_000).toFixed(1)}MB`);
    // Reveals are the whole point of the walkthrough: a take where they did
    // not fire looks like a static screenshot scrolling past.
    console.log(`             ${take.stops} stops, ${take.revealsFired} reveals fired` +
      (take.revealsStuck > 0 ? `, ${take.revealsStuck} STUCK (did not animate on camera)` : ''));
  }
  console.log();
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exit(1);
}
