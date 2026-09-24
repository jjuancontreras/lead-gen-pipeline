/**
 * Per-lead, per-stage status for the demo pipeline.
 *
 * Kept in its own file (`<data dir>/pipeline-state.json`) rather than in the
 * lead store: the store may be the production Google Sheet, whose column
 * layout other tools depend on, and a run's bookkeeping does not belong in it.
 *
 * Every update is read-modify-write with an atomic rename, and every read is
 * validated. The file is small - one entry per lead the pipeline has touched.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  STAGE_NAMES, StateFile, PENDING,
  type StageEntry, type StageName, type LeadStages,
} from './schemas.ts';

const EMPTY: StateFile = { version: 1, leads: {} };

export class PipelineState {
  constructor(readonly path: string) {}

  read(): StateFile {
    if (!existsSync(this.path)) return EMPTY;
    const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    const parsed = StateFile.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${this.path} is not a valid pipeline state file: ${parsed.error.issues[0]?.message}`);
    }
    return parsed.data;
  }

  private write(state: StateFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n');
    renameSync(tmp, this.path);
  }

  stages(leadId: string): LeadStages {
    return this.read().leads[leadId] ?? {};
  }

  entry(leadId: string, stage: StageName): StageEntry {
    return this.stages(leadId)[stage] ?? PENDING;
  }

  /** Merge `patch` into one stage's entry and persist. Returns the new entry. */
  update(leadId: string, stage: StageName, patch: Partial<StageEntry>): StageEntry {
    const state = this.read();
    const lead = state.leads[leadId] ?? {};
    const next: StageEntry = { ...(lead[stage] ?? PENDING), ...patch };
    this.write({ ...state, leads: { ...state.leads, [leadId]: { ...lead, [stage]: next } } });
    return next;
  }

  /**
   * Make `from` and every later stage pending again, for a retry. Attempt
   * counts are kept so a lead that keeps failing is visible as such.
   */
  reset(leadId: string, from: StageName): void {
    const state = this.read();
    const lead = state.leads[leadId] ?? {};
    const later = STAGE_NAMES.slice(STAGE_NAMES.indexOf(from));
    const cleared = Object.fromEntries(later.map((s) => [
      s, { status: 'pending' as const, attempts: lead[s]?.attempts ?? 0 },
    ]));
    this.write({ ...state, leads: { ...state.leads, [leadId]: { ...lead, ...cleared } } });
  }

  leadIds(): string[] {
    return Object.keys(this.read().leads);
  }
}
