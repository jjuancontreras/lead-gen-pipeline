/**
 * Campaign stage registry.
 *
 * The Sheet's `status` column IS the pipeline state. Each stage declares
 * which statuses it consumes; the orchestrator just asks "who is eligible"
 * and runs them in order. Three properties fall out of that for free:
 *
 *   - resume is free: a crash or rate-limit costs nothing, re-run continues
 *   - idempotent: re-running an area re-does no completed work
 *   - hand-drivable: edit a status cell and the next run honours it
 *
 * Stages must never hold state of their own.
 */
import './env.ts';  // loads .env.local before anything reads process.env
import { gmailCredsUsable } from './gmail-creds.ts';
import type { Lead, Status } from './lead.ts';

export interface StageContext {
  area: string;
  areaLabel: string;
  dryRun: boolean;
  caps: Caps;
  log: (msg: string) => void;
}

export interface Caps {
  /** Max Google Maps lookups in one run. */
  maxFetches: number;
  /** Max Gemini calls in one run. */
  maxGeminiCalls: number;
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
  maxGeminiCalls: 200,
  maxScaffolds: 3,
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
  /** Statuses this stage consumes. Empty means it does not read leads. */
  consumes: Status[];
  /** Whether the stage can run without credentials being configured. */
  requires?: 'gemini' | 'gmail' | 'sheets';
  run(ctx: StageContext): Promise<StageResult>;
}

/** Registry, in execution order. */
const registry: Stage[] = [];

export function registerStage(stage: Stage): void {
  registry.push(stage);
}

export function stages(): readonly Stage[] {
  return registry;
}

export function findStage(name: string): Stage | undefined {
  return registry.find((s) => s.name === name);
}

/** Is a credential-gated stage runnable right now? */
export function credentialAvailable(req: Stage['requires']): boolean {
  if (!req) return true;
  if (req === 'gemini') return Boolean(process.env.GEMINI_API_KEY);
  if (req === 'sheets') return Boolean(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SA_KEY_PATH);
  if (req === 'gmail') {
    const p = process.env.GMAIL_TOKEN_PATH;
    return p ? gmailCredsUsable(p) : false;
  }
  return true;
}
