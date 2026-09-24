/**
 * Stage: draft first contact for verified leads.
 *
 * This stage never sends. Email becomes a Gmail *draft*; every social
 * channel becomes a markdown file you copy-paste by hand. There is no flag
 * to change that - automated DMs get Meta accounts banned, and an automated
 * send has nobody reading it before a real business does.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openStore } from '../store.ts';
import { renderTemplate, pickChannel, type Channel, type Rendered } from '../outreach.ts';
import {
  DRAFT_DIR, destination, draftFileBody, draftIndexBody, draftFileNames, earlierDrafts,
  withdrawnBody, INDEX_FILE, WITHDRAWN_MARKER, type DraftRow, type WithdrawnDraft,
} from '../draft-file.ts';
import { selectPool, templateFor } from '../outreach-policy.ts';
import { loadGmailCreds, gmailReady, type GmailCreds } from '../gmail-creds.ts';
import { today } from '../dates.ts';
import { withRetry } from '../retry.ts';
import type { Stage, StageResult } from '../campaign-stages.ts';
import { isSuppressed, type Lead, type Tier } from '../lead.ts';

/**
 * Outreach has no entry in `Caps`, so the stage carries its own ceiling.
 *
 * The 3 / 7 / 14 cadence itself lives in `src/cadence.ts`: it is arithmetic
 * on `first_contacted_at`, and it is applied when a human confirms a send
 * (`npm run sent`), not when this stage writes a file.
 */
export const DEFAULT_OUTREACH_LIMIT = 20;

const GMAIL_TIMEOUT_MS = 30_000;

// ---- Gmail ------------------------------------------------------------------

/** RFC 2047 encoded-word - business names are not all ASCII. */
const encodeHeader = (s: string): string =>
  /^[ -~]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

/**
 * A header value can never contain a line break.
 *
 * The sheet is meant to be edited by hand, so an address cell is not a
 * trusted string. A CR or LF inside one would splice an extra header - a Bcc,
 * say - into the raw MIME a human is about to press Send on, where reviewing
 * the visible To and Subject would not reveal it.
 */
const headerValue = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

export function mimeMessage(to: string, subject: string, body: string): string {
  return [
    `To: ${headerValue(to)}`,
    `Subject: ${encodeHeader(headerValue(subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ].join('\r\n');
}

/**
 * Create a Gmail draft. `googleapis` is imported dynamically so the fallback
 * path - the only path until credentials exist - never loads it, and a
 * broken dependency cannot take the file drafts down with it.
 */
async function createGmailDraft(creds: GmailCreds, to: string, r: Rendered): Promise<string> {
  const { google } = await import('googleapis');
  const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  auth.setCredentials({ refresh_token: creds.refresh_token });
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = Buffer.from(mimeMessage(to, r.subject ?? '', r.body), 'utf8').toString('base64url');
  // A retry after a timeout can leave two drafts if the first request did
  // land. Two drafts of one email is a nuisance; a run that hangs forever on
  // one lead is worse.
  const res = await withRetry(
    (_attempt, signal) => gmail.users.drafts.create(
      { userId: 'me', requestBody: { message: { raw } } }, { signal },
    ),
    { attempts: 2, timeoutMs: GMAIL_TIMEOUT_MS, label: 'Gmail draft create' },
  );
  return res.data.id ?? '(created)';
}

// ---- file drafts ------------------------------------------------------------

function writeDraftFile(
  lead: Lead, channel: Channel, template: string, r: Rendered, now: string,
): string {
  mkdirSync(DRAFT_DIR, { recursive: true });
  const [primary, alt] = draftFileNames(lead);
  // A different business whose name happens to slugify the same must never
  // bury a do_not_contact record under a fresh, sendable draft.
  const taken = existsSync(join(DRAFT_DIR, primary))
    && readFileSync(join(DRAFT_DIR, primary), 'utf8').includes(WITHDRAWN_MARKER);
  const path = join(DRAFT_DIR, taken ? alt : primary);
  writeFileSync(path, draftFileBody(lead, channel, template, r, now));
  return path;
}

/**
 * Empty the draft of anyone who has since opted out.
 *
 * selectPool drops suppressed leads, which is correct but not sufficient: a
 * lead flagged AFTER a draft was written keeps a finished, ready-to-send
 * message sitting on disk, and the index goes on offering it. The file is
 * overwritten with a tombstone rather than deleted, so the record survives
 * and the sendable text does not.
 *
 * Files only. A Gmail draft, once the token works, lives in the mailbox and
 * has to be retracted there by hand.
 */
export function withdrawSuppressedDrafts(
  all: readonly Lead[], area: string, now: string, dir: string = DRAFT_DIR,
): WithdrawnDraft[] {
  const out: WithdrawnDraft[] = [];
  for (const lead of all) {
    if (lead.area !== area || !isSuppressed(lead)) continue;
    // Both names, because a collision may have pushed this lead's draft onto
    // the second one - and the point is to leave no sendable text behind.
    for (const file of draftFileNames(lead)) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      writeFileSync(path, withdrawnBody(lead.name, now));
      out.push({ name: lead.name, file });
    }
  }
  return out;
}

/**
 * One list of everything waiting to be sent, rewritten from scratch each run.
 *
 * Drafts written by earlier runs are listed too - they are still unsent, and
 * an index that quietly forgot them would be worse than no index.
 */
function writeDraftIndex(
  rows: readonly DraftRow[], withdrawn: readonly WithdrawnDraft[], now: string,
): string {
  mkdirSync(DRAFT_DIR, { recursive: true });
  const written = new Set([...rows, ...withdrawn].map((r) => r.file));
  const path = join(DRAFT_DIR, INDEX_FILE);
  writeFileSync(path, draftIndexBody(rows, earlierDrafts(DRAFT_DIR, written), now, withdrawn));
  return path;
}

// ---- the stage --------------------------------------------------------------

export interface OutreachOptions {
  area: string;
  limit: number;
  template?: string;
  /** B is the volume tier for first contact; A waits for a built demo. */
  tiers?: Tier[];
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface OutreachReport {
  attempted: number;
  drafted: number;
  gmailDrafts: number;
  files: string[];
  /** The index listing those files. Written on every non-dry run. */
  indexPath?: string;
  /** Drafts emptied this run because their lead opted out. */
  withdrawn: WithdrawnDraft[];
  gmailReady: boolean;
  skipped: { lead: Lead; reason: string }[];
}

export async function draftOutreach(opts: OutreachOptions): Promise<OutreachReport> {
  const log = opts.log ?? (() => {});
  const store = openStore();
  const now = today();

  const all = await store.all();
  const pool = selectPool(all, {
    area: opts.area,
    template: opts.template,
    tiers: opts.tiers ?? ['B'],
    today: now,
  }).slice(0, opts.limit);

  // Checked per lead's channel below, not by skipping the stage: Instagram,
  // Messenger and TikTok never touch Gmail, and a missing token just means
  // email drafts land in files instead.
  const report: OutreachReport = {
    attempted: pool.length, drafted: 0, gmailDrafts: 0,
    files: [], gmailReady: gmailReady(), skipped: [], withdrawn: [],
  };

  // Runs even when the pool is empty - an opt-out is usually the REASON the
  // pool is empty, and that is exactly when the old draft has to go.
  if (!opts.dryRun) report.withdrawn = withdrawSuppressedDrafts(all, opts.area, now);

  const creds = pool.length > 0 && report.gmailReady
    ? loadGmailCreds(process.env.GMAIL_TOKEN_PATH!) : null;
  const rows: DraftRow[] = [];
  // 'drafted', not 'tier1_sent': writing a file is not sending a message, and
  // nothing in this codebase sends. The contact timestamps and next action
  // date are written by `npm run sent`, once a human confirms the send.
  const drafted = new Map<string, Partial<Lead>>();

  // One batched write at the end. If a lead throws mid-run (a Gmail API
  // error, say), the drafts already written are still recorded - and the
  // original error is the one that surfaces, not a follow-on store error.
  const record = () => store.updateMany(drafted);
  try {
    for (const lead of pool) {
      const channel = pickChannel(lead);
      if (!channel) {
        report.skipped.push({ lead, reason: 'no contact channel on the record' });
        continue;
      }
      const template = opts.template ?? templateFor(lead, channel, now);

      let rendered: Rendered;
      try {
        rendered = renderTemplate(template, lead);
      } catch (err) {
        // One lead with a missing field must not cost the whole batch.
        report.skipped.push({ lead, reason: (err as Error).message });
        continue;
      }

      let where: string;
      if (opts.dryRun) {
        where = 'dry run';
      } else if (channel === 'email' && creds) {
        const id = await createGmailDraft(creds, destination(lead, channel), rendered);
        report.gmailDrafts++;
        where = `gmail draft ${id}`;
      } else {
        const path = writeDraftFile(lead, channel, template, rendered, now);
        report.files.push(path);
        rows.push({
          name: lead.name,
          channel,
          destination: destination(lead, channel),
          tier: lead.tier,
          template,
          file: basename(path),
        });
        where = path;
      }

      if (!opts.dryRun) drafted.set(lead.lead_id, { status: 'drafted', channel_used: channel });
      report.drafted++;
      log(`${lead.name.slice(0, 32).padEnd(33)} ${channel.padEnd(10)} ${template.padEnd(13)} ${where}`);
    }
  } catch (err) {
    await record().catch((e: Error) => log(`could not record ${drafted.size} drafted lead(s): ${e.message}`));
    throw err;
  }
  await record();

  // A dry run writes nothing at all, index included. Every other run rewrites
  // the index even with nothing new, so a withdrawal shows up immediately.
  if (!opts.dryRun) report.indexPath = writeDraftIndex(rows, report.withdrawn, now);
  return report;
}

export const outreachStage: Stage = {
  name: 'outreach',
  description: 'draft first contact and due follow-ups (drafts only, never sends)',
  async run(ctx): Promise<StageResult> {
    const r = await draftOutreach({
      area: ctx.area,
      limit: DEFAULT_OUTREACH_LIMIT,
      dryRun: ctx.dryRun,
      log: ctx.log,
    });
    const pulled = r.withdrawn.length
      ? `, ${r.withdrawn.length} withdrawn (do_not_contact)` : '';
    if (r.attempted === 0) {
      return { processed: 0, summary: `nobody is due for contact${pulled}` };
    }
    const sink = r.gmailReady
      ? `${r.gmailDrafts} gmail drafts, ${r.files.length} files`
      : `${r.files.length} files in data/drafts (no GMAIL_TOKEN_PATH - nothing lost)`;
    return {
      processed: r.drafted,
      summary: `drafted ${r.drafted}/${r.attempted}: ${sink}`
        + (r.skipped.length ? `, ${r.skipped.length} skipped` : '') + pulled
        + `. Nothing sent - review and send each one by hand.`,
      handoff: r.skipped,
    };
  },
};
