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
  /**
   * Max demo sites scaffolded per run. Default 3: you can service 3-5
   * clients a month, so there is no reason for one run to scaffold twenty
   * and burn a morning of disk, quota and attention.
   */
  maxScaffolds: number;
  /** Max leads verified in one run. */
  maxVerify: number;
}

export const DEFAULT_CAPS: Caps = {
  maxFetches: 60,
  maxScaffolds: 3,
  maxVerify: 40,
};

export interface StageResult {
  /** Short human-readable outcome for the run log and the brief. */
  summary: string;
  processed: number;
  /** Leads that need a person, with the reason why. */
  handoff?: { lead: Lead; reason: string }[];
  /** Extra lines the brief prints under this stage's summary. */
  briefNotes?: string[];
}

export interface Stage {
  name: string;
  description: string;
  run(ctx: StageContext): Promise<StageResult>;
}
