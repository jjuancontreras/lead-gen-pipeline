/**
 * `npm run pipeline` - take leads through find -> site -> video -> email.
 *
 * Kept apart from bin/pipeline.ts so the bin can set the environment for a
 * fixture run before settings are first read.
 */
import { dataPath } from '../config.ts';
import { openStore, type LeadStore } from '../store.ts';
import { rootLogger, type Logger } from '../log.ts';
import { settings } from '../settings.ts';
import { intFlag, multiFlag, val } from '../cli-args.ts';
import type { Lead } from '../lead.ts';
import { PipelineState } from './state.ts';
import { STAGE_NAMES, type StageName } from './schemas.ts';
import { runPipeline, type LeadResult, type RunSummary } from './runner.ts';
import { acquireRunLock } from '../run-lock.ts';
import { loadFixtureLeads, selectForDemo, stageContext } from './leads.ts';

export const USAGE = `
Usage: npm run pipeline -- <what to run>

  --fixtures <file>          import fixture businesses (JSON store only) and run them
  --lead <id> [--lead ...]   run these leads from the store
  --area <key> [--limit 3]   run the area's verified tier-A leads with no website
  --retry <lead_id>:<stage>  reset that stage and every later one, then run the lead
  --status                   print every lead's stage status and exit

Nothing is ever sent. SEND_EMAILS must be false; emails are drafts on disk.
`;

const MARK: Record<string, string> = { done: 'done', failed: 'FAILED', pending: '-', running: 'running' };

export function formatTable(rows: readonly LeadResult[]): string {
  const width = Math.min(34, Math.max(8, ...rows.map((r) => r.name.length)));
  const head = `  ${'lead'.padEnd(width)}  ${STAGE_NAMES.map((s) => s.padEnd(8)).join('')}`;
  const lines = rows.map((r) =>
    `  ${r.name.slice(0, width).padEnd(width)}  ${STAGE_NAMES.map((s) => MARK[r.stages[s]]!.padEnd(8)).join('')}` +
    (r.error ? `\n  ${''.padEnd(width)}  ${r.error.stage}: ${r.error.message}` : ''));
  return [head, ...lines].join('\n');
}

function parseRetry(raw: string): { leadId: string; stage: StageName } {
  const at = raw.lastIndexOf(':');
  const leadId = raw.slice(0, at);
  const stage = raw.slice(at + 1) as StageName;
  if (at < 1 || !STAGE_NAMES.includes(stage)) {
    throw new Error(`--retry wants <lead_id>:<stage>, stage one of ${STAGE_NAMES.join(', ')}; got "${raw}"`);
  }
  return { leadId, stage };
}

function statusRows(leads: readonly Lead[], state: PipelineState): LeadResult[] {
  const byId = new Map(leads.map((l) => [l.lead_id, l]));
  return state.leadIds().map((id) => {
    const stages = state.stages(id);
    const failed = STAGE_NAMES.find((s) => stages[s]?.status === 'failed');
    return {
      lead_id: id,
      name: byId.get(id)?.name ?? id,
      stages: Object.fromEntries(STAGE_NAMES.map((s) => [s, stages[s]?.status ?? 'pending'])) as LeadResult['stages'],
      ...(failed ? { error: { stage: failed, message: stages[failed]!.error ?? '' } } : {}),
    };
  });
}

/** The leads this invocation names, or null when it names none (print usage). */
async function chooseLeads(
  argv: readonly string[], store: LeadStore, state: PipelineState, log: Logger,
): Promise<Lead[] | null> {
  const all = await store.all();
  const fixtures = val('--fixtures', argv);
  const retry = val('--retry', argv);
  if (fixtures) {
    // Fixtures are made-up businesses. They must never land in the Sheet.
    if (store.kind !== 'json') throw new Error('--fixtures runs only against the JSON store (PIPELINE_STORE=json)');
    const loaded = loadFixtureLeads(fixtures);
    const { added } = await store.upsert(loaded);
    log.info('fixtures loaded', { file: fixtures, businesses: loaded.length, added });
    const ids = new Set(loaded.map((l) => l.lead_id));
    return (await store.all()).filter((l) => ids.has(l.lead_id));
  }
  if (retry) {
    const { leadId, stage } = parseRetry(retry);
    const lead = all.find((l) => l.lead_id === leadId);
    if (!lead) throw new Error(`no lead ${leadId} in the store`);
    state.reset(leadId, stage);
    log.info('reset for retry', { lead: leadId, from: stage });
    return [lead];
  }
  if (argv.includes('--lead')) {
    const ids = multiFlag('--lead', argv);
    const missing = ids.filter((id) => !all.some((l) => l.lead_id === id));
    if (missing.length) throw new Error(`not in the store: ${missing.join(', ')}`);
    return all.filter((l) => ids.includes(l.lead_id));
  }
  const area = val('--area', argv);
  return area ? selectForDemo(all, area, intFlag('--limit', 3, argv)) : null;
}

function report(summary: RunSummary): number {
  const failed = summary.results.filter((r) => r.error).length;
  const complete = summary.results.filter((r) => STAGE_NAMES.every((st) => r.stages[st] === 'done')).length;
  console.log(`\n${formatTable(summary.results)}\n`);
  console.log(`  ${summary.results.length} lead(s): ${complete} fully done, ${failed} failed`);
  console.log(`  emails sent: ${summary.emailsSent} (drafts in ${dataPath('emails')})`);
  if (summary.writebackError) console.log(`  could not record demo links on the leads: ${summary.writebackError}`);
  console.log();
  return failed > 0 || summary.writebackError ? 1 : 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  const s = settings();
  const log = rootLogger();
  const store = openStore();
  const state = new PipelineState(dataPath('pipeline-state.json'));

  if (argv.includes('--status')) {
    console.log(`\n${formatTable(statusRows(await store.all(), state))}\n`);
    return 0;
  }

  // Everything from here writes the store or the state file: one run per
  // data directory at a time, whether it comes from here or the console.
  const lock = acquireRunLock(dataPath('pipeline.lock'));
  try {
    const leads = await chooseLeads(argv, store, state, log);
    if (!leads) {
      console.error(USAGE);
      return 1;
    }
    console.log(`\n  Demo pipeline: ${leads.length} lead(s)   store: ${store.kind}   data: ${s.dataDir}`);
    console.log(`  sending: OFF (drafts only)   links: ${s.publicBaseUrl}\n`);
    return report(await runPipeline({ leads, state, ctx: stageContext(log), store }));
  } finally {
    lock.release();
  }
}
