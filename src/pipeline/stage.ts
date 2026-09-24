/**
 * What every demo-pipeline stage is given and must provide.
 *
 * A stage is a function of one lead plus the earlier stages' outputs. It
 * holds no state: the runner persists what it returns, and decides from the
 * persisted state whether to run it at all.
 */
import type { Lead } from '../lead.ts';
import type { Logger } from '../log.ts';
import type { Mailer } from './mailer.ts';
import type {
  FoundLead, SiteArtifact, VideoArtifact, StageName, StageOutputs,
} from './schemas.ts';

export interface StageContext {
  dataDir: string;
  /** Prefix of the site and video links written into emails. */
  publicBaseUrl: string;
  /** Target walkthrough length. */
  videoMs: number;
  /** Always false outside tests: settings refuse SEND_EMAILS=true. */
  sendEmails: boolean;
  mailer: Mailer;
  senderName: string;
  senderEmail?: string;
  areaLabel: (area: string) => string;
  log: Logger;
}

export interface StageInput {
  lead: Lead;
  found?: FoundLead;
  site?: SiteArtifact;
  video?: VideoArtifact;
}

export interface PipelineStage<N extends StageName = StageName> {
  readonly name: N;
  readonly description: string;
  run(input: StageInput, ctx: StageContext): Promise<StageOutputs[N]>;
  /** A `done` output whose files are gone must be rebuilt, not trusted. */
  isIntact(output: StageOutputs[N]): boolean;
}

/** The earlier stage's output, or a clear error if the runner let it through without one. */
export function need<T>(value: T | undefined, stage: StageName): T {
  if (value === undefined) throw new Error(`the ${stage} stage has no output for this lead`);
  return value;
}
