/**
 * Who is due for outreach, and with which template.
 *
 * Pure rules over Lead records - no store, no filesystem - shared by the
 * outreach stage (which drafts) and the console (which previews). A preview
 * must never promise a message a campaign run would not actually draft, so
 * both read the same functions rather than keeping copies that drift apart.
 */
import { pickChannel, templateForChannel, channelForTemplate, type Channel } from './outreach.ts';
import { followUpTemplateFor } from './cadence.ts';
import { isSuppressed, type Lead, type Tier } from './lead.ts';

/** Templates that open a conversation rather than continue one. */
export const FIRST_CONTACT_TEMPLATES: ReadonlySet<string> = new Set([
  'email-first', 'instagram-dm', 'messenger-dm',
]);

/**
 * A lead qualifies for a first-contact touch: qualified enough to reach out
 * to, and nobody has yet. Tier is deliberately not part of this - tier is a
 * campaign's own volume choice (`SelectOptions.tiers`), not a fact about the lead.
 */
export function isOpeningEligible(lead: Lead): boolean {
  return (lead.status === 'verified' || lead.status === 'scaffolded') && !lead.first_contacted_at;
}

/** A lead's follow-up is due on `today`. */
export function isFollowUpDue(lead: Lead, today: string): boolean {
  return lead.status === 'tier1_sent' && lead.next_action_date !== '' && lead.next_action_date <= today;
}

/**
 * The template a lead is due for: a contacted lead continues the 3/7/14
 * sequence (derived from `first_contacted_at`, so no column has to remember
 * the step); anyone else gets the opener written for their channel.
 */
export function templateFor(lead: Lead, channel: Channel, today: string): string {
  return lead.status === 'tier1_sent'
    ? followUpTemplateFor(lead.first_contacted_at, today)
    : templateForChannel(channel);
}

export interface SelectOptions {
  area: string;
  /** Explicit sequence step, or undefined to pick per lead by channel. */
  template?: string;
  tiers: Tier[];
  today: string;
}

/** Who is due, given the whole store, best stage-1 score first. */
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
