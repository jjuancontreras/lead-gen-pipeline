#!/usr/bin/env tsx
/**
 * Generate a single hero mockup for a demo site.
 *
 *   npm run mockup -- --slug gubat [--url http://localhost:3011] [--out path.png]
 *
 * This is the volume asset: ~10 minutes of work standing in for the 3-5 hour
 * full demo site, so a prospect gets a personalized image attached to a DM
 * instead of nothing. The dev server is NOT started for you - see
 * assertReachable's hint if it is not already running.
 */
import { generateMockup } from '../src/mockup.ts';
import { args, val } from '../src/cli-args.ts';

const slug = val('--slug');
if (!slug) {
  console.error('\nUsage: npm run mockup -- --slug <slug> [--url <url>] [--out <path>]\n');
  process.exit(1);
}

try {
  const report = await generateMockup({
    slug,
    url: val('--url'),
    outPath: val('--out'),
    headed: args.includes('--headed'),
    log: (m) => console.log('  ' + m),
  });

  console.log(`\n  mockup for ${report.slug}`);
  console.log(`    source: ${report.url}`);
  console.log(`    output: ${report.outPath}`);
  console.log(`    ${report.width}x${report.height}  ${(report.bytes / 1_000_000).toFixed(2)}MB`);
  console.log(
    `    hero: ${report.heroSelector ?? '(none found - plain viewport clip)'}` +
    (report.padded ? `, padded ${report.paddedPx}px to fill the frame` : ''),
  );
  console.log(
    `    splash cleared: ${report.splashCleared}  reveals settled: ${report.revealsSettled}`,
  );
  console.log(
    `    pixel stddev: ${report.pixelStdDev.toFixed(2)}  page text length: ${report.visibleTextLength}\n`,
  );
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exit(1);
}
