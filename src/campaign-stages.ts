/**
 * The campaign stage contract.
 *
 * The Sheet's `status` column IS the pipeline state: each stage reads the
 * store, picks the leads whose status it acts on, and writes the next status
 * back. Three properties fall out of that for free:
 *
 *   - resume is free: a crash or rate-limit costs nothing, re-run continues
 *   - idempotent: re-running an area re-does no completed work
 *   - hand-drivable: edit a status cell and the next run honours it
 *
 * Stages must never hold state of their own. The ordered list of stages is
 * `STAGES` in `stages/index.ts`.
 */
import type { Lead } from './lead.ts';

export interface StageContext {
  area: string;
  areaLabel: string;
  dryRun: boolean;
  caps: Caps;
  log: (msg: string) => void;
}

export interface Caps {
  /** Max page loads the enrich stage may spend in one run. */
  maxFetches: number;
  /** Max leads verified in one run. */
  maxVerify: number;
}

export const DEFAULT_CAPS: Caps = {
  maxFetches: 60,
  maxVerify: 40,
};

export interface StageResult {
  /** Short human-readable outcome for the run log and the brief. */
  summary: string;
  processed: number;
  /** Leads that need a person, with the reason why. */
  handoff?: { lead: Lead; reason: string }[];
}

export interface Stage {
  name: string;
  description: string;
  run(ctx: StageContext): Promise<StageResult>;
}
