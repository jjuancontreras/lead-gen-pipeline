/**
 * Stage: draft first contact for verified leads.
 *
 * This stage never sends. Email becomes a Gmail *draft*; every social
 * channel becomes a markdown file you copy-paste by hand. There is no flag
 * to change that - automated DMs get Meta accounts banned, and an automated
 * send has nobody reading it before a real business does.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../config.ts';
import { openStore } from '../store.ts';
import { slugify } from '../scaffold.ts';
import {
  renderTemplate, pickChannel, templateForChannel, channelForTemplate,
  type Channel, type Rendered,
} from '../outreach.ts';
import { credentialAvailable, registerStage, type StageResult } from '../campaign-stages.ts';
import { isSuppressed, type Lead, type Tier } from '../lead.ts';

export const DRAFT_DIR = dataPath('drafts');

/** Templates that open a conversation rather than continue one. */
export const FIRST_CONTACT_TEMPLATES: ReadonlySet<string> = new Set([
  'email-first', 'instagram-dm', 'messenger-dm',
]);

/**
 * Days until the next touch, per template. The cadence is 3 / 7 / 14 from
 * first contact, so each step schedules only the gap to the next one. `null`
 * ends the sequence: after the breakup there is nothing left to do.
 */
const NEXT_STEP_DAYS: Record<string, number | null> = {
  'email-first': 3,
  'instagram-dm': 3,
  'messenger-dm': 3,
  'follow-up-3': 4,
  'follow-up-7': 7,
  'breakup-14': null,
};

/** Outreach has no entry in `Caps`, so the stage carries its own ceiling. */
export const DEFAULT_OUTREACH_LIMIT = 20;

const today = (): string => new Date().toISOString().slice(0, 10);

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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
export function selectPool(all: readonly Lead[], opts: SelectOptions): Lead[] {
  const wantTier = new Set<Tier>(opts.tiers);
  const opening = !opts.template || FIRST_CONTACT_TEMPLATES.has(opts.template);

  let pool = all.filter((l) => {
    if (l.area !== opts.area) return false;
    // Belt and braces: renderTemplate refuses these too, but a suppressed
    // lead should never even reach a rendering attempt.
    if (isSuppressed(l)) return false;
    if (opening) {
      return l.status === 'verified' && wantTier.has(l.tier) && !l.first_contacted_at;
    }
    return l.status === 'tier1_sent'
      && l.next_action_date !== ''
      && l.next_action_date <= opts.today;
  });

  // A channel-specific template must not be aimed at the wrong channel: the
  // email body is six paragraphs and would be ignored as an Instagram DM.
  const only = opts.template ? channelForTemplate(opts.template) : null;
  if (only) pool = pool.filter((l) => pickChannel(l) === only);

  return pool.sort((a, b) => Number(b.osm_score) - Number(a.osm_score));
}

/** Where a human goes to send this by hand. */
export function destination(lead: Lead, channel: Channel): string {
  const raw = (lead[channel] ?? '').trim();
  if (channel === 'email') return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  const handle = raw.replace(/^@/, '');
  if (channel === 'instagram') return `https://www.instagram.com/${handle}/`;
  if (channel === 'facebook') return `https://www.facebook.com/${handle}`;
  return `https://www.tiktok.com/@${handle}`;
}

// ---- Gmail ------------------------------------------------------------------

interface GmailCreds { client_id: string; client_secret: string; refresh_token: string }

/**
 * Read the OAuth token file. Accepts a flat `{client_id, client_secret,
 * refresh_token}` or Google's downloaded `{installed: {...}}` shape with the
 * refresh token merged in, because both are what people actually end up with.
 */
export function loadGmailCreds(path: string): GmailCreds {
  const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const nested = (json.installed ?? json.web ?? {}) as Record<string, unknown>;
  const pick = (k: string) => String(json[k] ?? nested[k] ?? '').trim();
  const creds = {
    client_id: pick('client_id'),
    client_secret: pick('client_secret'),
    refresh_token: pick('refresh_token'),
  };
  const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) throw new Error(`${path} is missing: ${missing.join(', ')}`);
  return creds;
}

/** RFC 2047 encoded-word - business names are not all ASCII. */
const encodeHeader = (s: string): string =>
  /^[ -~]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

export function mimeMessage(to: string, subject: string, body: string): string {
  return [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
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

export function draftFileBody(
  lead: Lead, channel: Channel, template: string, r: Rendered,
): string {
  const head = [
    `# ${lead.name}`,
    ``,
    `**Nothing here has been sent.** Copy the block below the rule and send it yourself.`,
    ``,
    `- lead: \`${lead.lead_id}\` (${lead.tier || 'no tier'}, ${lead.status})`,
    `- channel: **${channel}** -> ${destination(lead, channel)}`,
    `- template: \`${template}\``,
    `- rendered: ${today()}`,
    ``,
    `---`,
    ``,
  ];
  // The subject line only exists on email. Printing it above a DM would just
  // get pasted into the DM.
  if (channel === 'email' && r.subject) head.push(`Subject: ${r.subject}`, ``);
  return head.join('\n') + r.body;
}

function writeDraftFile(lead: Lead, channel: Channel, template: string, r: Rendered): string {
  mkdirSync(DRAFT_DIR, { recursive: true });
  const path = join(DRAFT_DIR, `${slugify(lead.name)}.md`);
  writeFileSync(path, draftFileBody(lead, channel, template, r));
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
  gmailReady: boolean;
  skipped: { lead: Lead; reason: string }[];
}

export async function draftOutreach(opts: OutreachOptions): Promise<OutreachReport> {
  const log = opts.log ?? (() => {});
  const store = openStore();
  const now = today();

  const pool = selectPool(await store.all(), {
    area: opts.area,
    template: opts.template,
    tiers: opts.tiers ?? ['B'],
    today: now,
  }).slice(0, opts.limit);

  const gmailReady = credentialAvailable('gmail');
  const report: OutreachReport = {
    attempted: pool.length, drafted: 0, gmailDrafts: 0,
    files: [], gmailReady, skipped: [],
  };
  if (pool.length === 0) return report;

  const creds = gmailReady ? loadGmailCreds(process.env.GMAIL_TOKEN_PATH!) : null;

  for (const lead of pool) {
    const channel = pickChannel(lead);
    if (!channel) {
      report.skipped.push({ lead, reason: 'no contact channel on the record' });
      continue;
    }
    const template = opts.template ?? templateForChannel(channel);

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
      const path = writeDraftFile(lead, channel, template, rendered);
      report.files.push(path);
      where = path;
    }

    if (!opts.dryRun) {
      const gap = NEXT_STEP_DAYS[template];
      await store.update(lead.lead_id, {
        // The breakup is the end of the sequence, and 'nurture' is INACTIVE -
        // which is what stops the orchestrator picking them up forever.
        status: template === 'breakup-14' ? 'nurture' : 'tier1_sent',
        channel_used: channel,
        // first_contacted_at is written once and never rewritten: it is the
        // start of the clock the whole cadence is measured against.
        ...(lead.first_contacted_at ? {} : { first_contacted_at: now }),
        last_contacted_at: now,
        next_action_date: gap == null ? '' : addDays(now, gap),
      });
    }
    report.drafted++;
    log(`${lead.name.slice(0, 32).padEnd(33)} ${channel.padEnd(10)} ${template.padEnd(13)} ${where}`);
  }
  return report;
}

registerStage({
  name: 'outreach',
  description: 'draft first contact for B-tier leads (drafts only, never sends)',
  consumes: ['verified'],
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
    if (r.attempted === 0) return { processed: 0, summary: 'nobody is due for first contact' };
    const sink = r.gmailReady
      ? `${r.gmailDrafts} gmail drafts, ${r.files.length} files`
      : `${r.files.length} files in data/drafts (no GMAIL_TOKEN_PATH - nothing lost)`;
    return {
      processed: r.drafted,
      summary: `drafted ${r.drafted}/${r.attempted}: ${sink}`
        + (r.skipped.length ? `, ${r.skipped.length} skipped` : '')
        + `. Nothing sent - review and send each one by hand.`,
      handoff: r.skipped,
    };
  },
});
