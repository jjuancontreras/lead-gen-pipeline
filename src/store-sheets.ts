/**
 * Google Sheets backend for the lead store.
 *
 * The Sheet is the source of truth precisely because a person can open it and
 * edit a cell - that is what makes the pipeline hand-drivable. Everything
 * awkward in this file follows from that:
 *
 *   - The header is verified, never assumed. If somebody drags a column, the
 *     positional row mapping silently writes emails into the phone column and
 *     nothing looks wrong until outreach goes out. So a header that does not
 *     match COLUMNS is a hard error naming the exact cell, not a repair.
 *
 *   - Reads are whole-sheet and writes are batched ranges. The Sheets quota is
 *     60 requests per minute per user; one call per lead would exhaust it on a
 *     single medium-sized area and leave the store half-written.
 *
 *   - `googleapis` is imported dynamically. store.ts imports this module
 *     eagerly to decide which backend to open, and the JSON path - still the
 *     only path most of the time - must not pay for a client it never builds.
 *
 * Every function above the class is pure so the parts that can be wrong
 * quietly (mapping, dedupe, ranges) are testable without credentials.
 */
import './env.ts';  // loads .env.local before anything reads process.env
import { readFileSync } from 'node:fs';
import { type Lead, type Status, COLUMNS, fromRow, toRow } from './lead.ts';
import type { LeadStore, UpsertResult } from './store.ts';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_TIMEOUT_MS = 30_000;

/** Default tab name. The pipeline creates nothing; this tab must exist. */
export const DEFAULT_TAB = 'Leads';

// ---- A1 ranges (pure) -------------------------------------------------------

/** 1 -> A, 26 -> Z, 27 -> AA. Sheets columns are bijective base-26. */
export function columnLetter(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Column index must be a positive integer, got ${index}`);
  }
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The rightmost column the lead schema occupies. */
export const LAST_COLUMN = columnLetter(COLUMNS.length);

export function a1Range(tab: string, firstRow: number, lastRow: number): string {
  // A tab whose name contains a space or punctuation has to be quoted, and an
  // embedded apostrophe doubled - otherwise the API reads it as a range.
  const name = /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`;
  return `${name}!A${firstRow}:${LAST_COLUMN}${lastRow}`;
}

/** Everything, header included. Open-ended so the row count need not be known. */
export function fullRange(tab: string): string {
  const name = /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`;
  return `${name}!A1:${LAST_COLUMN}`;
}

// ---- header (pure) ----------------------------------------------------------

export const HEADER_ROW: string[] = COLUMNS.map(String);

/**
 * Why a mismatched header is fatal, in one sentence: rows are mapped by
 * POSITION, so a header that disagrees with COLUMNS means every read and every
 * write is off by however many columns somebody inserted.
 *
 * Returns a human-readable description of the first problem, or null when the
 * header is exactly right.
 */
export function headerMismatch(header: readonly string[]): string | null {
  const actual = header.map((h) => (h ?? '').trim());
  // Trailing blanks are how Sheets reports an unused cell, not a real column.
  while (actual.length > 0 && actual[actual.length - 1] === '') actual.pop();

  for (let i = 0; i < HEADER_ROW.length; i++) {
    const want = HEADER_ROW[i]!;
    const got = actual[i];
    if (got === undefined) {
      return `column ${columnLetter(i + 1)} is missing - expected "${want}"`;
    }
    if (got !== want) {
      return `column ${columnLetter(i + 1)} is "${got}" but the schema says "${want}"`;
    }
  }
  if (actual.length > HEADER_ROW.length) {
    const extra = actual.slice(HEADER_ROW.length);
    return `${extra.length} unexpected column(s) after ${LAST_COLUMN}: ${extra.join(', ')}`;
  }
  return null;
}

export function assertHeader(header: readonly string[], where: string): void {
  const problem = headerMismatch(header);
  if (problem) {
    throw new Error(
      `${where} header does not match the lead schema: ${problem}. ` +
      `Refusing to read or write - the columns are mapped by position, so ` +
      `continuing would scramble every lead. Fix row 1 to match src/lead.ts COLUMNS.`,
    );
  }
}

// ---- row mapping (pure) -----------------------------------------------------

/**
 * Sheet values -> leads. `values` is the raw whole-sheet read, header included.
 *
 * Sheets truncates trailing empty cells, so rows arrive ragged; `fromRow`
 * already tolerates that. Rows with no lead_id are spacers or notes a person
 * left behind - they are skipped rather than turned into a blank lead.
 */
export function sheetToLeads(values: readonly (readonly string[])[]): Lead[] {
  return values
    .slice(1)
    .filter((row) => (row[0] ?? '').trim() !== '')
    .map((row) => fromRow([...row]));
}

export interface AppendPlan {
  /** Rows to write, already in column order. Empty when there is nothing new. */
  rows: string[][];
  /** 1-based sheet row the first new row goes to. */
  firstRow: number;
  added: number;
  skipped: number;
}

/**
 * What `upsert` should write. Insert-only, exactly like JsonStore: a lead_id
 * already in the sheet is skipped, never overwritten, because the sheet may
 * carry a person's hand-edits that a fresh scrape would flatten.
 *
 * `existingRowCount` is the total row count of the sheet, header included, so
 * the first free row is that plus one.
 */
export function appendPlan(
  existing: readonly Lead[], incoming: readonly Lead[], existingRowCount: number,
): AppendPlan {
  const seen = new Set(existing.map((l) => l.lead_id));
  const rows: string[][] = [];
  let skipped = 0;
  for (const lead of incoming) {
    // Dedupe within the batch too - one source run can return the same POI
    // twice, and the sheet would not catch it because neither row is there yet.
    if (seen.has(lead.lead_id)) { skipped++; continue; }
    seen.add(lead.lead_id);
    rows.push(toRow(lead));
  }
  // A sheet holding only a header has one row, so the first free row is 2.
  const firstRow = Math.max(existingRowCount, 1) + 1;
  return { rows, firstRow, added: rows.length, skipped };
}

export interface UpdatePlan {
  /** 1-based sheet row to overwrite. */
  row: number;
  values: string[];
}

/**
 * What `update` should write: the whole row, merged. Rewriting the full row
 * rather than the changed cells keeps it to one range write no matter how many
 * fields the patch touches.
 *
 * This works on the RAW sheet values, not on the mapped leads, on purpose. A
 * person can leave a blank spacer row in the middle of the sheet; `sheetToLeads`
 * drops it, so a lead's index in that array is not its row number. Locating the
 * row by scanning column A is the only mapping that stays true.
 */
export function updatePlan(
  values: readonly (readonly string[])[], leadId: string, patch: Partial<Lead>,
): UpdatePlan {
  const i = values.findIndex((row, n) => n > 0 && (row[0] ?? '').trim() === leadId);
  if (i === -1) throw new Error(`No such lead: ${leadId}`);
  return { row: i + 1, values: toRow({ ...fromRow([...values[i]!]), ...patch }) };
}

/**
 * Every row a batch should write, planned against one snapshot. Keyed by
 * lead_id so no row can be written twice, and an unknown id throws while
 * planning - before a single cell has been written.
 */
export function batchUpdatePlan(
  values: readonly (readonly string[])[], patches: ReadonlyMap<string, Partial<Lead>>,
): UpdatePlan[] {
  return [...patches].map(([leadId, patch]) => updatePlan(values, leadId, patch));
}

// ---- credentials ------------------------------------------------------------

export interface ServiceAccount { client_email: string; private_key: string }

/** The two fields a JWT needs. Anything else in the key file is Google's. */
export function parseServiceAccount(raw: string, path: string): ServiceAccount {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const client_email = String(json.client_email ?? '').trim();
  const private_key = String(json.private_key ?? '');
  const missing = [
    ...(client_email ? [] : ['client_email']),
    ...(private_key.trim() ? [] : ['private_key']),
  ];
  if (missing.length > 0) {
    throw new Error(
      `${path} is missing: ${missing.join(', ')}. ` +
      `Expected a Google service-account key JSON, not an OAuth client file.`,
    );
  }
  return { client_email, private_key };
}

export function loadServiceAccount(path: string): ServiceAccount {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read GOOGLE_SA_KEY_PATH (${path}): ${(err as Error).message}`);
  }
  return parseServiceAccount(raw, path);
}

// ---- the store --------------------------------------------------------------

/** The slice of the Sheets client this store uses. Keeps googleapis at arm's length. */
interface ValuesApi {
  get(params: { spreadsheetId: string; range: string }):
    Promise<{ data: { values?: unknown[][] | null } }>;
  update(params: {
    spreadsheetId: string; range: string; valueInputOption: string;
    requestBody: { values: string[][] };
  }): Promise<unknown>;
  batchUpdate(params: {
    spreadsheetId: string;
    requestBody: { valueInputOption: string; data: { range: string; values: string[][] }[] };
  }): Promise<unknown>;
}

const asStrings = (values: unknown[][] | null | undefined): string[][] =>
  (values ?? []).map((row) => row.map((cell) => (cell == null ? '' : String(cell))));

export class SheetsStore implements LeadStore {
  readonly kind = 'sheets' as const;
  readonly location: string;
  private api: ValuesApi | null = null;

  constructor(
    private readonly spreadsheetId: string,
    private readonly keyPath: string,
    private readonly tab: string = DEFAULT_TAB,
  ) {
    this.location = `https://docs.google.com/spreadsheets/d/${spreadsheetId} (${tab})`;
  }

  /** Built once per process, on first use - never at import time. */
  private async values(): Promise<ValuesApi> {
    if (this.api) return this.api;
    const creds = loadServiceAccount(this.keyPath);
    const { google } = await import('googleapis');
    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: [SHEETS_SCOPE],
    });
    // A timeout, so a stalled request cannot hang a run. gaxios retries only
    // idempotent methods (GET, PUT) with backoff, so a POST append is never
    // repeated into a duplicate row.
    this.api = google.sheets({
      version: 'v4', auth, timeout: SHEETS_TIMEOUT_MS, retry: true,
    }).spreadsheets.values as unknown as ValuesApi;
    return this.api;
  }

  /**
   * The one read every operation shares: whole sheet, header checked once.
   * An empty sheet gets its header written here rather than in three places.
   */
  private async snapshot(): Promise<{ values: string[][]; leads: Lead[] }> {
    const api = await this.values();
    const res = await api.get({ spreadsheetId: this.spreadsheetId, range: fullRange(this.tab) });
    const values = asStrings(res.data.values);

    if (values.length === 0) {
      await api.update({
        spreadsheetId: this.spreadsheetId,
        range: a1Range(this.tab, 1, 1),
        valueInputOption: 'RAW',
        requestBody: { values: [HEADER_ROW] },
      });
      return { values: [HEADER_ROW], leads: [] };
    }
    assertHeader(values[0]!, this.location);
    return { values, leads: sheetToLeads(values) };
  }

  async all(): Promise<Lead[]> {
    return (await this.snapshot()).leads;
  }

  async byStatus(...statuses: Status[]): Promise<Lead[]> {
    const want = new Set<string>(statuses);
    return (await this.snapshot()).leads.filter((l) => want.has(l.status));
  }

  async upsert(leads: Lead[]): Promise<UpsertResult> {
    const snap = await this.snapshot();
    const plan = appendPlan(snap.leads, leads, snap.values.length);
    if (plan.rows.length === 0) return { added: 0, skipped: plan.skipped };

    // One write for the whole batch, at a range computed from the snapshot we
    // just read. This assumes a single writer, which is what the pipeline is -
    // if that ever stops being true, this is the call to switch to append.
    const api = await this.values();
    await api.update({
      spreadsheetId: this.spreadsheetId,
      range: a1Range(this.tab, plan.firstRow, plan.firstRow + plan.rows.length - 1),
      valueInputOption: 'RAW',
      requestBody: { values: plan.rows },
    });
    return { added: plan.added, skipped: plan.skipped };
  }

  async update(leadId: string, patch: Partial<Lead>): Promise<void> {
    await this.updateMany(new Map([[leadId, patch]]));
  }

  /** One read and one write for the whole batch, however many leads it names. */
  async updateMany(patches: ReadonlyMap<string, Partial<Lead>>): Promise<void> {
    if (patches.size === 0) return;
    const plans = batchUpdatePlan((await this.snapshot()).values, patches);
    const api = await this.values();
    await api.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: plans.map((p) => ({ range: a1Range(this.tab, p.row, p.row), values: [p.values] })),
      },
    });
  }
}

/**
 * Open the Sheets backend from the environment. Throws rather than falling
 * back to JSON: a run that silently wrote to a local file when it was told to
 * use the Sheet would be worse than one that stopped.
 */
export function openSheetsStore(): LeadStore {
  const sheetId = (process.env.GOOGLE_SHEET_ID ?? '').trim();
  const keyPath = (process.env.GOOGLE_SA_KEY_PATH ?? '').trim();
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID is not set');
  if (!keyPath) throw new Error('GOOGLE_SA_KEY_PATH is not set');
  const tab = (process.env.GOOGLE_SHEET_TAB ?? '').trim() || DEFAULT_TAB;
  return new SheetsStore(sheetId, keyPath, tab);
}
