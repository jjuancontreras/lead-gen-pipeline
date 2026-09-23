/**
 * Lead store.
 *
 * Google Sheets is the intended source of truth, but the pipeline must be
 * runnable before those credentials exist - so a local JSON backend
 * implements the same interface. Same code path either way; only the
 * backing file changes.
 *
 * The store is deliberately dumb: no caching, no derived state. The
 * `status` column is the pipeline's only state, which is what makes
 * `campaign` resumable and hand-editable.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from './config.ts';
import { type Lead, type Status, COLUMNS, fromRow, toRow } from './lead.ts';
import { openSheetsStore } from './store-sheets.ts';

export interface UpsertResult { added: number; skipped: number }

export interface LeadStore {
  readonly kind: 'json' | 'sheets';
  readonly location: string;
  all(): Promise<Lead[]>;
  /** Insert leads whose lead_id is not already present. Never overwrites. */
  upsert(leads: Lead[]): Promise<UpsertResult>;
  update(leadId: string, patch: Partial<Lead>): Promise<void>;
  /**
   * Patch several leads with one read and one write. All-or-nothing on
   * unknown ids: nothing is written if any lead_id is missing.
   */
  updateMany(patches: ReadonlyMap<string, Partial<Lead>>): Promise<void>;
  byStatus(...statuses: Status[]): Promise<Lead[]>;
}

export class JsonStore implements LeadStore {
  readonly kind = 'json' as const;
  constructor(readonly location: string) {}

  private read(): Lead[] {
    if (!existsSync(this.location)) return [];
    const raw = JSON.parse(readFileSync(this.location, 'utf8')) as { rows: string[][] };
    return (raw.rows ?? []).map(fromRow);
  }

  private write(leads: Lead[]): void {
    mkdirSync(dirname(this.location), { recursive: true });
    const payload = {
      _attribution:
        'Roster data (c) OpenStreetMap contributors, ODbL 1.0 - https://www.openstreetmap.org/copyright',
      columns: COLUMNS,
      rows: leads.map(toRow),
    };
    // Write-then-rename: a crash mid-write must not truncate the lead store.
    const tmp = this.location + '.tmp';
    writeFileSync(tmp, JSON.stringify(payload, null, 1) + '\n');
    renameSync(tmp, this.location);
  }

  async all(): Promise<Lead[]> { return this.read(); }

  async upsert(leads: Lead[]): Promise<UpsertResult> {
    const existing = this.read();
    const seen = new Set(existing.map((l) => l.lead_id));
    let added = 0, skipped = 0;
    for (const lead of leads) {
      if (seen.has(lead.lead_id)) { skipped++; continue; }
      existing.push(lead);
      seen.add(lead.lead_id);
      added++;
    }
    if (added > 0) this.write(existing);
    return { added, skipped };
  }

  async update(leadId: string, patch: Partial<Lead>): Promise<void> {
    await this.updateMany(new Map([[leadId, patch]]));
  }

  async updateMany(patches: ReadonlyMap<string, Partial<Lead>>): Promise<void> {
    if (patches.size === 0) return;
    const rows = this.read();
    const known = new Set(rows.map((l) => l.lead_id));
    for (const id of patches.keys()) if (!known.has(id)) throw new Error(`No such lead: ${id}`);
    this.write(rows.map((l) => ({ ...l, ...patches.get(l.lead_id) })));
  }

  async byStatus(...statuses: Status[]): Promise<Lead[]> {
    const want = new Set<string>(statuses);
    return this.read().filter((l) => want.has(l.status));
  }
}

/**
 * Pick a backend. Sheets when credentials are configured, JSON otherwise.
 * The JSON path is not a toy - it is the correct store until the service
 * account exists, and stays useful for dry runs and tests.
 */
export function openStore(opts: { forceJson?: boolean } = {}): LeadStore {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const keyPath = process.env.GOOGLE_SA_KEY_PATH;
  if (!opts.forceJson && sheetId && keyPath) {
    return openSheetsStore();
  }
  return new JsonStore(dataPath('leads.json'));
}
