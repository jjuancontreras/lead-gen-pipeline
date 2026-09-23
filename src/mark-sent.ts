/**
 * Record that a draft was actually sent.
 *
 * Nothing in this codebase sends a message, so nothing in this codebase can
 * know that one went out - only a human can. Until this runs, a lead sits at
 * `drafted`: a file exists, a person has not pressed Send. Marking it here is
 * what starts the 3 / 7 / 14 clock, which is why the clock cannot be started
 * by the act of writing a file.
 *
 * Pure selection and patch functions, so both rules are testable without a
 * store, a sheet or a filesystem.
 */
import { nextActionAfter } from './cadence.ts';
import { slugify } from './normalize.ts';
import { isSuppressed, type Lead } from './lead.ts';

/** The status a draft waits in until a human confirms the send. */
export const DRAFTED: Lead['status'] = 'drafted';

export interface SentSelection {
  /** Restrict to one area. Omitted means every area. */
  area?: string;
  /** lead_id or the slug of the lead's name, as it appears in data/drafts/. */
  ids?: readonly string[];
  /** Take every drafted lead in the area rather than named ones. */
  all?: boolean;
}

export interface SentPlan {
  /** Leads that will be patched. */
  chosen: Lead[];
  /** Ids asked for that matched no drafted lead, verbatim. */
  unmatched: string[];
  /** Drafted leads skipped because they have since opted out. */
  suppressed: Lead[];
}

/**
 * Why this lead cannot be confirmed sent, or null if it can. The one rule
 * behind both `npm run sent` and the console's "Mark as sent" button: a flag
 * left off, or an opt-out, must never record contact.
 */
export function sentRefusal(lead: Lead): string | null {
  if (lead.status !== DRAFTED) return `lead is "${lead.status}", not "${DRAFTED}" - nothing to confirm`;
  if (isSuppressed(lead)) return 'lead is flagged do_not_contact';
  return null;
}

/**
 * Work out which leads a `npm run sent` invocation refers to.
 *
 * An id may be a lead_id or the file slug, because the index a human is
 * reading lists slugs and the sheet lists lead_ids - asking them to translate
 * between the two is how the wrong business gets marked as contacted.
 */
export function planSent(all: readonly Lead[], sel: SentSelection): SentPlan {
  const drafted = all.filter((l) => l.status === DRAFTED
    && (sel.area === undefined || l.area === sel.area));

  const suppressed = drafted.filter(isSuppressed);
  const sendable = drafted.filter((l) => sentRefusal(l) === null);

  if (sel.all || !sel.ids || sel.ids.length === 0) {
    return { chosen: sendable, unmatched: [], suppressed };
  }

  const chosen: Lead[] = [];
  const unmatched: string[] = [];
  for (const raw of sel.ids) {
    const want = raw.trim().toLowerCase().replace(/\.md$/, '');
    const hit = sendable.find((l) => l.lead_id.toLowerCase() === want
      || slugify(l.name) === want);
    if (hit && !chosen.includes(hit)) chosen.push(hit);
    else if (!hit) unmatched.push(raw);
  }
  return { chosen, unmatched, suppressed };
}

/**
 * The columns a confirmed send writes.
 *
 * `first_contacted_at` is written once and never rewritten: it is the start of
 * the clock the whole cadence is measured against, so a follow-up must not
 * push it forward or the sequence would never finish. An empty
 * `next_action_date` means the breakup has gone out and there is nothing left
 * to schedule - `nurture` is INACTIVE, which is what stops the orchestrator
 * picking the lead up forever.
 */
export function sentPatch(lead: Lead, now: string): Partial<Lead> {
  const first = lead.first_contacted_at || now;
  const next = nextActionAfter(first, now);
  return {
    status: next === '' ? 'nurture' : 'tier1_sent',
    ...(lead.first_contacted_at ? {} : { first_contacted_at: first }),
    last_contacted_at: now,
    next_action_date: next,
  };
}
