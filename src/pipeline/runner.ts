/**
 * The demo pipeline runner: find -> site -> video -> email, per lead.
 *
 *   - Per-lead isolation: a stage that throws marks that lead's stage failed,
 *     with the error, and the runner moves on to the next lead. Later stages
 *     for that lead stay pending.
 *   - Resumable and idempotent: a stage recorded `done` whose output still
 *     validates and still exists on disk is skipped. A `running` entry left
 *     behind by a crash is simply run again, as is a `failed` one.
 *   - Every output is parsed with its schema before it is stored, and again
 *     when the next stage reads it.
 */
import { ZodError } from 'zod';
import { INACTIVE, STATUSES, type Lead, type Status } from '../lead.ts';
import type { LeadStore } from '../store.ts';
import type { Logger } from '../log.ts';
import { PipelineState } from './state.ts';
import {
  STAGE_NAMES, STAGE_OUTPUT,
  type StageName, type StageOutputs, type StageStatus,
} from './schemas.ts';
import type { PipelineStage, StageContext, StageInput } from './stage.ts';
import { findStage } from './stages/find.ts';
import { siteStage } from './stages/site.ts';
import { videoStage } from './stages/video.ts';
import { emailStage } from './stages/email.ts';

export const PIPELINE_STAGES: readonly PipelineStage[] = [findStage, siteStage, videoStage, emailStage];

export interface LeadResult {
  lead_id: string;
  name: string;
  stages: Record<StageName, StageStatus>;
  /** The first failure, if any. */
  error?: { stage: StageName; message: string };
}

export interface RunSummary {
  results: LeadResult[];
  emailsSent: number;
  /** Set when writing demo links back to the lead store failed. */
  writebackError?: string;
}

export interface RunOptions {
  leads: readonly Lead[];
  state: PipelineState;
  ctx: StageContext;
  /** Receives demo_slug / demo_url / video_url once a lead is fully done. */
  store?: LeadStore;
  stages?: readonly PipelineStage[];
  clock?: () => Date;
}

/** One line a person can act on - a zod error is otherwise a JSON blob. */
export function errorMessage(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

/** The done output of a stage, if it is still valid and intact on disk. */
function reusable<N extends StageName>(
  stage: PipelineStage<N>, output: unknown,
): StageOutputs[N] | null {
  const parsed = STAGE_OUTPUT[stage.name].safeParse(output);
  if (!parsed.success) return null;
  const value = parsed.data as StageOutputs[N];
  return stage.isIntact(value) ? value : null;
}

/** The next stage's input: this one's plus the output just produced. */
function withOutput(input: StageInput, name: StageName, output: unknown): StageInput {
  return { ...input, [name === 'find' ? 'found' : name]: output };
}

async function runLead(lead: Lead, opts: RunOptions, log: Logger): Promise<LeadResult> {
  const stages = opts.stages ?? PIPELINE_STAGES;
  const clock = opts.clock ?? (() => new Date());
  let input: StageInput = { lead };
  const result: LeadResult = {
    lead_id: lead.lead_id,
    name: lead.name,
    stages: { find: 'pending', site: 'pending', video: 'pending', email: 'pending' },
  };

  for (const stage of stages) {
    const slog = log.child({ stage: stage.name });
    const entry = opts.state.entry(lead.lead_id, stage.name);

    if (entry.status === 'done') {
      const kept = reusable(stage, entry.output);
      if (kept) {
        input = withOutput(input, stage.name, kept);
        result.stages[stage.name] = 'done';
        slog.debug('already done - skipped');
        continue;
      }
      slog.warn('recorded as done but its output is missing or invalid - rebuilding');
    }

    opts.state.update(lead.lead_id, stage.name, {
      status: 'running', attempts: entry.attempts + 1,
      startedAt: clock().toISOString(), finishedAt: undefined, error: undefined, output: undefined,
    });
    const started = Date.now();
    try {
      const raw = await stage.run(input, { ...opts.ctx, log: slog });
      const output = STAGE_OUTPUT[stage.name].parse(raw);
      opts.state.update(lead.lead_id, stage.name, {
        status: 'done', output, finishedAt: clock().toISOString(),
      });
      input = withOutput(input, stage.name, output);
      result.stages[stage.name] = 'done';
      slog.info('done', { ms: Date.now() - started });
    } catch (err) {
      const message = errorMessage(err);
      opts.state.update(lead.lead_id, stage.name, {
        status: 'failed', error: message, finishedAt: clock().toISOString(),
      });
      result.stages[stage.name] = 'failed';
      result.error = { stage: stage.name, message };
      slog.error('failed', { err: message });
      break;
    }
  }
  return result;
}

/** Advance the lead's campaign status to demo_built, never backwards. */
function nextStatus(current: Status): Status | undefined {
  if (INACTIVE.has(current)) return undefined;
  return STATUSES.indexOf(current) < STATUSES.indexOf('demo_built') ? 'demo_built' : undefined;
}

/** Links from every fully-done lead, as one batched store write. */
function writebackPatches(leads: readonly Lead[], state: PipelineState): Map<string, Partial<Lead>> {
  const patches = new Map<string, Partial<Lead>>();
  for (const lead of leads) {
    const stages = state.stages(lead.lead_id);
    if (!STAGE_NAMES.every((s) => stages[s]?.status === 'done')) continue;
    const site = STAGE_OUTPUT.site.parse(stages.site!.output);
    const video = STAGE_OUTPUT.video.parse(stages.video!.output);
    const status = nextStatus(lead.status);
    const patch: Partial<Lead> = {
      demo_slug: site.slug, demo_url: site.url, video_url: video.url,
      ...(status ? { status } : {}),
    };
    const changed = Object.entries(patch).some(([k, v]) => lead[k as keyof Lead] !== v);
    if (changed) patches.set(lead.lead_id, patch);
  }
  return patches;
}

export async function runPipeline(opts: RunOptions): Promise<RunSummary> {
  const results: LeadResult[] = [];
  for (const lead of opts.leads) {
    const log = opts.ctx.log.child({ lead: lead.lead_id });
    // runLead catches stage errors itself; this catch is for the runner's own
    // bookkeeping (a state file that cannot be written), so one lead's
    // disaster still does not take the others down with it.
    try {
      results.push(await runLead(lead, opts, log));
    } catch (err) {
      const message = errorMessage(err);
      log.error('lead aborted', { err: message });
      results.push({
        lead_id: lead.lead_id, name: lead.name,
        stages: { find: 'pending', site: 'pending', video: 'pending', email: 'pending' },
        error: { stage: 'find', message },
      });
    }
  }

  const emailsSent = results.reduce((n, r) => {
    const out = opts.state.entry(r.lead_id, 'email').output as { sent?: boolean } | undefined;
    return n + (r.stages.email === 'done' && out?.sent ? 1 : 0);
  }, 0);

  const summary: RunSummary = { results, emailsSent };
  if (opts.store) {
    const patches = writebackPatches(opts.leads, opts.state);
    try {
      await opts.store.updateMany(patches);
      if (patches.size) opts.ctx.log.info('recorded demo links on the leads', { leads: patches.size });
    } catch (err) {
      summary.writebackError = errorMessage(err);
      opts.ctx.log.error('could not record demo links on the leads', { err: summary.writebackError });
    }
  }
  return summary;
}
