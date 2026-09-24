#!/usr/bin/env tsx
/**
 * The demo pipeline: find -> site -> video -> email. Never sends anything.
 *
 *   npm run pipeline -- --fixtures test/fixtures/businesses.json
 *   npm run pipeline -- --area katipunan --limit 3
 *   npm run pipeline -- --retry node/123:video
 *   npm run pipeline -- --status
 *
 * A fixture run is pinned to the JSON store in `.pipeline-fixture/` unless
 * PIPELINE_DATA_DIR says otherwise, so made-up businesses can never reach
 * the real lead store. That has to happen before settings are first read,
 * hence the dynamic import.
 */
const argv = process.argv.slice(2);
if (argv.includes('--fixtures')) {
  process.env.PIPELINE_STORE = 'json';
  process.env.PIPELINE_DATA_DIR ??= '.pipeline-fixture';
}

const { main } = await import('../src/pipeline/cli.ts');
try {
  process.exitCode = await main(argv);
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exitCode = 1;
}

export {};
