/**
 * What the console shows as one lead's message: the actual saved draft or
 * withdrawal if one exists on disk, otherwise an unsaved live preview of what
 * a campaign run would draft - or the reason there is neither.
 *
 * The fenced markdown is parsed here, once, into fields; the browser gets
 * data, not a document to re-parse.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DRAFT_DIR, draftFileNames, destination, gmailComposeLink, parseDraftBody, WITHDRAWN_MARKER,
} from './draft-file.ts';
import { renderTemplate, pickChannel, type Channel } from './outreach.ts';
import { isOpeningEligible, isFollowUpDue, templateFor } from './outreach-policy.ts';
import { DRAFTED } from './mark-sent.ts';
import { isSuppressed, type Lead } from './lead.ts';

export type DraftView =
  | { kind: 'suppressed' }
  | { kind: 'withdrawn'; file: string }
  | {
      kind: 'draft'; file: string; link: string | null;
      /** The channel the draft went out on, as recorded when it was written. */
      channel?: string;
      to?: string; subject?: string; body?: string;
      /** The whole file, for drafts that predate the fenced-field format. */
      markdown?: string;
      canMarkSent: boolean;
    }
  | {
      kind: 'preview'; channel: Channel; to: string; subject?: string; body: string;
      link: string | null; canMarkSent: false;
    }
  | { kind: 'none'; reason: string };

export function draftView(lead: Lead, now: string, dir: string = DRAFT_DIR): DraftView {
  if (isSuppressed(lead)) return { kind: 'suppressed' };
  return savedDraft(lead, dir) ?? preview(lead, now);
}

/** Whatever is on disk wins - it is exactly what would be, or was, sent. */
function savedDraft(lead: Lead, dir: string): DraftView | null {
  for (const file of draftFileNames(lead)) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    if (raw.includes(WITHDRAWN_MARKER)) return { kind: 'withdrawn', file };

    const { fields, link } = parseDraftBody(raw);
    const structured = Object.keys(fields).length > 0;
    return {
      kind: 'draft', file, link,
      channel: lead.channel_used || undefined,
      to: fields.to, subject: fields.subject, body: fields.body ?? fields.message,
      markdown: structured ? undefined : raw,
      canMarkSent: lead.status === DRAFTED,
    };
  }
  return null;
}

/** Rendered, never written: a preview only for a lead a run would draft. */
function preview(lead: Lead, now: string): DraftView {
  if (!(isOpeningEligible(lead) || isFollowUpDue(lead, now))) {
    return { kind: 'none', reason: 'No draft or preview available at this stage.' };
  }
  const channel = pickChannel(lead);
  if (!channel) return { kind: 'none', reason: 'No contact channel on file yet.' };
  try {
    const rendered = renderTemplate(templateFor(lead, channel, now), lead);
    const to = destination(lead, channel);
    const link = channel === 'email' ? gmailComposeLink(to, rendered.subject ?? '', rendered.body) : to;
    return {
      kind: 'preview', channel, to, subject: rendered.subject, body: rendered.body, link,
      canMarkSent: false,
    };
  } catch (err) {
    return { kind: 'none', reason: (err as Error).message };
  }
}
