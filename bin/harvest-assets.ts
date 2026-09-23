#!/usr/bin/env tsx
/**
 * Harvest a business's public Instagram photos, curate them with Gemini
 * vision (guarded behind GEMINI_API_KEY), and OCR any menu graphic found.
 *
 *   npm run harvest -- --slug kuro-cafe --ig kurocafe [--limit 12]
 *
 * With no GEMINI_API_KEY set, this still downloads and (if `sharp` is
 * installed) optimizes the photos - only the vision curation/OCR steps are
 * skipped, with a clear note in the output. Nothing here ever silently
 * no-ops or crashes on a missing key or a missing dependency.
 *
 * Thin wrapper over src/harvest.ts.
 */
import '../src/env.ts';  // loads .env.local before anything reads process.env
import { harvestAssets, DEFAULT_LIMIT } from '../src/harvest.ts';
import { WEBSITES_ROOT } from '../src/scaffold.ts';
import { args, val } from '../src/cli-args.ts';

const slug = val('--slug');
const ig = val('--ig');

const usage = `
Usage: npm run harvest -- --slug <kebab-case-slug> --ig <handle-or-url> [--limit ${DEFAULT_LIMIT}]

  --slug   demo site slug, e.g. kuro-cafe (must already be scaffolded, or
           the output directory is created for you under research/images)
  --ig     Instagram handle ("kurocafe"), "@kurocafe", or a profile URL
  --limit  how many grid photos to pull (default ${DEFAULT_LIMIT}, clamped 4-20)
`;

if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error(usage);
  process.exit(1);
}
if (!ig) {
  console.error(usage);
  process.exit(1);
}

const apiKey = process.env.GEMINI_API_KEY;
console.log(`\nHarvesting assets for ${slug}  (@${ig.replace(/^@/, '')})`);
console.log(
  apiKey
    ? '  Gemini curation + menu OCR: enabled (GEMINI_API_KEY is set)'
    : '  Gemini curation + menu OCR: SKIPPED - GEMINI_API_KEY is not set. Photos will still download.',
);
console.log();

const report = await harvestAssets({
  slug,
  ig,
  limit: Number(val('--limit')) || undefined,
  websitesRoot: WEBSITES_ROOT,
  apiKey,
  log: (m) => console.log('  ' + m),
});

if (!report.ok) {
  console.error(`\n  FAILED: ${report.message}\n`);
  process.exit(1);
}

console.log(`\n  ${report.message}`);
console.log(`  images:     ${report.imagesDownloaded.length} -> ${report.outDir}`);
if (report.imagesFailed.length) {
  console.log(`  failed:     ${report.imagesFailed.length}`);
  for (const f of report.imagesFailed.slice(0, 5)) console.log(`    ${f.url}  (${f.error})`);
}
if (report.curation) {
  console.log(`  curation:   ${report.curation.selected.length} images analysed`);
  console.log(`  brand look: ${report.curation.brandVisualLanguage}`);
} else {
  console.log(`  curation:   skipped (${report.curationSkippedReason})`);
}
if (report.menu) {
  console.log(`  menu OCR:   ${report.menu.items.length} items -> research/notes/menu.json`);
} else {
  console.log(`  menu OCR:   skipped (${report.menuSkippedReason})`);
}
console.log(`  recommended for the site (${report.recommendedForSite.length}):`);
for (const f of report.recommendedForSite) console.log(`    ${f}`);
console.log();
