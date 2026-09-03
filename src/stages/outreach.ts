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
import { dataPath } from '../config.ts';
import { openStore } from '../store.ts';
import { slugify } from '../scaffold.ts';
import {
  renderTemplate, pickChannel, templateForChannel, channelForTemplate,
  type Channel, type Rendered,
} from '../outreach.ts';
import {
  today, destination, draftFileBody, draftIndexBody, draftFileNames, earlierDrafts,
  withdrawnBody, INDEX_FILE, WITHDRAWN_MARKER, type DraftRow, type WithdrawnDraft,
} from '../draft-file.ts';
import { followUpTemplateFor } from '../cadence.ts';
import { credentialAvailable, registerStage, type StageResult } from '../campaign-stages.ts';
import { isSuppressed, type Lead, type Tier } from '../lead.ts';

// The markdown lives in ../draft-file.ts; re-exported so existing importers
// (and tests) keep the paths they already use.
export { destination, draftFileBody, gmailComposeLink, MAX_COMPOSE_URL } from '../draft-file.ts';

export const DRAFT_DIR = dataPath('drafts');

/** Templates that open a conversation rather than continue one. */
export const FIRST_CONTACT_TEMPLATES: ReadonlySet<string> = new Set([
  'email-first', 'instagram-dm', 'messenger-dm',
]);

/**
 * Outreach has no entry in `Caps`, so the stage carries its own ceiling.
 *
 * The 3 / 7 / 14 cadence itself lives in `src/cadence.ts` now: it is arithmetic
 * on `first_contacted_at`, and it is applied when a human confirms a send
 * (`npm run sent`), not when this stage writes a file.
 */
export const DEFAULT_OUTREACH_LIMIT = 20;

export interface SelectOptions {
  area: string;
  /** Explicit sequence step, or undefined to pick per lead by channel. */
  template?: string;
  tiers: Tier[];
  today: string;
}

/**
 * Who is due, given the whole store. Pure, so the selection rules can be
 * tested without a store or a filesystem.
 */
/**
 * A lead qualifies for a first-contact touch: qualified enough to reach out
 * to, and nobody has yet. Tier is deliberately not part of this - tier is a
 * campaign's own volume choice (`wantTier` below), not a fact about the lead.
 */
export function isOpeningEligible(lead: Lead): boolean {
  return (lead.status === 'verified' || lead.status === 'scaffolded') && !lead.first_contacted_at;
}

/**
 * A lead's follow-up is due today. This is the one piece of `selectPool`'s
 * eligibility that `bin/console.ts` also needs (to know whether a "preview"
 * is honest), so it is exported rather than kept private - the alternative
 * is a second, hand-copied notion of "due" that can drift from this one.
 */
export function isFollowUpDue(lead: Lead, today: string): boolean {
  return lead.status === 'tier1_sent' && lead.next_action_date !== '' && lead.next_action_date <= today;
}

export function selectPool(all: readonly Lead[], opts: SelectOptions): Lead[] {
  const wantTier = new Set<Tier>(opts.tiers);
  // No template means "whatever each lead is due for". The campaign never
  // passes one, and without both branches the 3/7/14 cadence was unreachable
  // from `npm run campaign`: every run only ever opened new conversations.
  const opening = !opts.template || FIRST_CONTACT_TEMPLATES.has(opts.template);
  const following = !opts.template || !FIRST_CONTACT_TEMPLATES.has(opts.template);

  let pool = all.filter((l) => {
    if (l.area !== opts.area) return false;
    // Belt and braces: renderTemplate refuses these too, but a suppressed
    // lead should never even reach a rendering attempt.
    if (isSuppressed(l)) return false;
    if (opening && isOpeningEligible(l) && wantTier.has(l.tier)) return true;
    if (following && isFollowUpDue(l, opts.today)) return true;
    return false;
  });

  // A channel-specific template must not be aimed at the wrong channel: the
  // email body is six paragraphs and would be ignored as an Instagram DM.
  const only = opts.template ? channelForTemplate(opts.template) : null;
  if (only) pool = pool.filter((l) => pickChannel(l) === only);

  return pool.sort((a, b) => Number(b.osm_score) - Number(a.osm_score));
}

// ---- Gmail ------------------------------------------------------------------

import { loadGmailCreds, type GmailCreds } from '../gmail-creds.ts';

export { loadGmailCreds, type GmailCreds };

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
  const res = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
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

  const gmailReady = credentialAvailable('gmail');
  const report: OutreachReport = {
    attempted: pool.length, drafted: 0, gmailDrafts: 0,
    files: [], gmailReady, skipped: [], withdrawn: [],
  };

  // Runs even when the pool is empty - an opt-out is usually the REASON the
  // pool is empty, and that is exactly when the old draft has to go.
  if (!opts.dryRun) report.withdrawn = withdrawSuppressedDrafts(all, opts.area, now);

  const creds = pool.length > 0 && gmailReady
    ? loadGmailCreds(process.env.GMAIL_TOKEN_PATH!) : null;
  const rows: DraftRow[] = [];

  for (const lead of pool) {
    const channel = pickChannel(lead);
    if (!channel) {
      report.skipped.push({ lead, reason: 'no contact channel on the record' });
      continue;
    }
    // A due follow-up continues the sequence; anything else opens one. The
    // step is derived from first_contacted_at, so no column has to remember it.
    const template = opts.template ?? (lead.status === 'tier1_sent'
      ? followUpTemplateFor(lead.first_contacted_at, now)
      : templateForChannel(channel));

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

    if (!opts.dryRun) {
      // 'drafted', not 'tier1_sent': writing a file is not sending a message,
      // and nothing in this codebase sends. Recording contact here starts the
      // 3/7/14 clock on a draft nobody has opened yet, so the whole sequence
      // would run against a business that never heard from us. The contact
      // timestamps and the next action date are written by `npm run sent`,
      // once a human confirms the message actually went out.
      await store.update(lead.lead_id, { status: 'drafted', channel_used: channel });
    }
    report.drafted++;
    log(`${lead.name.slice(0, 32).padEnd(33)} ${channel.padEnd(10)} ${template.padEnd(13)} ${where}`);
  }

  // A dry run writes nothing at all, index included. Every other run rewrites
  // the index even with nothing new, so a withdrawal shows up immediately.
  if (!opts.dryRun) report.indexPath = writeDraftIndex(rows, report.withdrawn, now);
  return report;
}

registerStage({
  name: 'outreach',
  description: 'draft first contact and due follow-ups (drafts only, never sends)',
  // 'tier1_sent' too: selectPool also picks up leads whose follow-up is due.
  consumes: ['verified', 'scaffolded', 'tier1_sent'],
  // Deliberately NOT `requires: 'gmail'`. Gating the stage would also skip
  // Instagram, Messenger and TikTok, which never touch Gmail, and would turn
  // the documented no-credentials fallback into "stage skipped". The Gmail
  // check happens per lead instead, via credentialAvailable('gmail').
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
});
