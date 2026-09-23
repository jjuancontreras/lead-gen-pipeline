#!/usr/bin/env tsx
/**
 * Deploy a demo site to Vercel.
 *   npm run publish -- --slug <slug> [--dry-run]
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { WEBSITES_ROOT } from '../src/scaffold.ts';
import { args, val } from '../src/cli-args.ts';

const execFileAsync = promisify(execFile);

const dryRun = args.includes('--dry-run');

const slug = val('--slug');
if (!slug) {
  console.error('\nUsage: npm run publish -- --slug <slug> [--dry-run]\n');
  process.exit(1);
}

// Validate slug: alphanumeric and hyphens, starts with alphanumeric.
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error(`\nError: slug must match /^[a-z0-9][a-z0-9-]*$/\n`);
  process.exit(1);
}

const siteDir = `${WEBSITES_ROOT}/${slug}`;

// Resolve and validate site directory exists.
if (!existsSync(siteDir)) {
  console.error(`\nError: site directory does not exist: ${siteDir}\n`);
  process.exit(1);
}

console.log(`\nPublishing ${slug}${dryRun ? '  [DRY RUN]' : ''}`);

type Step = { name: string; run: () => Promise<string>; deployedUrl?: string };
const steps: Step[] = [
  {
    name: 'lint',
    run: () => execFileAsync('npm', ['--prefix', siteDir, 'run', 'lint']).then(() => 'ok'),
  },
  {
    name: 'build',
    run: () => execFileAsync('npm', ['--prefix', siteDir, 'run', 'build']).then(() => 'ok'),
  },
  {
    name: 'deploy',
    run: async () => {
      const { stdout } = await execFileAsync('npx', ['--yes', 'vercel', '--prod', '--yes'], {
        cwd: siteDir,
      });
      const match = stdout.match(/https:\/\/[^\s]+\.vercel\.app/);
      if (!match) {
        throw new Error('Deployment URL not found in vercel output');
      }
      return match[0];
    },
  },
  {
    name: 'verify',
    run: async () => {
      const url = steps[2]?.deployedUrl;
      if (!url) {
        throw new Error('Deployment URL not available');
      }
      const { stdout } = await execFileAsync('curl', ['-sI', url]);
      const statusMatch = stdout.match(/^HTTP\/[\d.]+\s+(\d+)/m);
      if (!statusMatch) {
        throw new Error('Could not parse curl status');
      }
      const status = statusMatch[1];
      if (status !== '200') {
        throw new Error(`HTTP ${status} from ${url}`);
      }
      return `HTTP ${status}`;
    },
  },
];

let currentStepName = '';

try {
  for (const step of steps) {
    currentStepName = step.name;
    console.log(`  ${step.name}...`);
    if (dryRun) {
      console.log(`    (dry run - skipped)`);
      continue;
    }
    const result = await step.run();
    if (step.name === 'deploy') {
      step.deployedUrl = result;
    }
    console.log(`    ${result}`);
  }

  if (!dryRun) {
    const deployUrl = steps[2]?.deployedUrl;
    console.log(`\n  URL: ${deployUrl}\n`);
  } else {
    console.log(`\n  (dry run completed)\n`);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${currentStepName} failed: ${msg}\n`);
  process.exit(1);
}
