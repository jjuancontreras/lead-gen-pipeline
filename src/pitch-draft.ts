/**
 * The Tier-2 pitch: "I built you a website - here it is, and here is a video
 * of it", drafted once the hand-built demo is deployed and recorded.
 *
 * Written to `data/drafts/` in the same format as every other draft, so you
 * send it the same way. Nothing here sends; Mark pitch sent in the Work Queue
 * records it afterwards (transitions.ts `pitch_sent`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTemplate } from './outreach.ts';
import { draftFileBody } from './draft-file.ts';
import { slugify } from './normalize.ts';
import { isSuppressed, type Lead } from './lead.ts';

export const PITCH_TEMPLATE = 'email-demo';

/** `<slug>-demo.md`, beside - never over - the lead's first-contact draft. */
export const pitchDraftPath = (lead: Lead, dir: string): string =>
  join(dir, `${slugify(lead.name)}-${slugify(lead.lead_id)}-demo.md`);

/** Why no pitch can be drafted for this lead yet, or null if one can. */
export function pitchRefusal(lead: Lead, senderEmail: string | undefined): string | null {
  if (isSuppressed(lead)) return 'lead is flagged do_not_contact';
  if (lead.status !== 'demo_built') return `lead is "${lead.status}"; a pitch needs demo_built`;
  if (!/^https?:\/\//.test(lead.demo_url)) return 'no demo URL on the lead - Mark built first';
  if (!/^https?:\/\//.test(lead.video_url)) return 'no video link on the lead - record, redeploy and set it first';
  if (!lead.email.trim()) return 'no email address on record - pitch by DM with the demo link instead';
  if (!senderEmail) return 'SENDER_EMAIL is not set - the email must say who it is from';
  return null;
}

export interface PitchDraft {
  path: string;
  to: string;
  subject: string;
  body: string;
}

export function writePitchDraft(
  lead: Lead, opts: { dir: string; senderEmail: string | undefined; now: string },
): PitchDraft {
  const refusal = pitchRefusal(lead, opts.senderEmail);
  if (refusal) throw new Error(refusal);
  const rendered = renderTemplate(PITCH_TEMPLATE, lead, {
    site_url: lead.demo_url,
    video_url: lead.video_url,
    sender_email: opts.senderEmail!,
  });
  mkdirSync(opts.dir, { recursive: true });
  const path = pitchDraftPath(lead, opts.dir);
  writeFileSync(path, draftFileBody(lead, 'email', PITCH_TEMPLATE, rendered, opts.now));
  return { path, to: lead.email.trim(), subject: rendered.subject ?? '', body: rendered.body };
}
