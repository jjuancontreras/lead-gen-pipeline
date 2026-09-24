/**
 * Outreach message rendering.
 *
 * Everything in here produces text for a person to read and send. Nothing
 * here can send anything, and that is the point: Meta bans accounts for DM
 * automation, and an unattended sender has no way to notice it is about to
 * embarrass you in front of a real business.
 *
 * Two hard invariants, both tested:
 *   - a suppressed lead is refused at every entry point (RA 10173 opt-out)
 *   - an unresolved {{placeholder}} throws instead of shipping
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadAreas } from './config.ts';
import { isHighIntent } from './website.ts';
import { today } from './dates.ts';
import { settings } from './settings.ts';
import { isSuppressed, type Lead, type WebsiteKind } from './lead.ts';

const TEMPLATE_DIR = join(ROOT, 'templates', 'outreach');

/** Channels that can carry a rendered message. Phone is not one of them. */
export type Channel = 'email' | 'instagram' | 'facebook' | 'tiktok';

/**
 * Contact priority, exactly as the worklist states it. `phone` holds its slot
 * here because it outranks the socials when a human is choosing what to do -
 * but a phone number is a call, not a message, so pickChannel steps over it
 * rather than stranding every phone-and-Instagram lead on `null`.
 */
export const CONTACT_PRIORITY = ['email', 'phone', 'instagram', 'facebook', 'tiktok'] as const;

/** First-contact copy, per channel. */
const CHANNEL_TEMPLATE: Record<Channel, string> = {
  email: 'email-first',
  instagram: 'instagram-dm',
  facebook: 'messenger-dm',
  // A TikTok DM is the same 3-sentence form on the same size screen. A fourth
  // near-identical file would be one more place for the copy to drift.
  tiktok: 'instagram-dm',
};

/** Templates written for one channel only; the rest are channel-agnostic. */
const TEMPLATE_CHANNELS: Record<string, Channel> = {
  'email-first': 'email',
  'email-demo': 'email',
  'instagram-dm': 'instagram',
  'messenger-dm': 'facebook',
};

/** Who is writing, and the numbers quoted in the copy. */
export const SENDER = {
  sender_name: 'Jfer Contreras',
  sender_year: '4th year',
  sender_course: 'Management Information Systems',
  sender_school: 'Ateneo de Manila University',
  price_range: 'PHP 5,000-7,000',
  maintenance_price: 'PHP 1,000/month',
  client_capacity: '3-5 clients a month',
} as const;

/**
 * Which half of the copy a lead gets. A business with a page it maintains
 * needs "there is nowhere to send people"; a business with nothing online
 * needs "there is nothing to find". Claiming the wrong one to someone who
 * runs an active Instagram is how a cold email gets deleted.
 */
export type Variant = 'social' | 'bare';

export function variantFor(lead: Lead): Variant {
  return isHighIntent(lead.website_kind) ? 'social' : 'bare';
}

const PAGE_KIND_LABEL: Partial<Record<WebsiteKind, string>> = {
  facebook: 'Facebook page',
  instagram: 'Instagram page',
  tiktok: 'TikTok',
  linktree: 'Linktree',
};

export interface Rendered {
  subject?: string;
  body: string;
}

/**
 * Every email ends with the same way out. DMs carry their own shorter one
 * ("If not, just say so"), which is why only messages with a subject are
 * checked. The exact line lives in the templates; this proves it is there.
 */
export const OPT_OUT_MARKER = 'Not interested? Reply "no thanks"';

/** Throws if an email (a message with a subject) has no opt-out line. */
export function assertEmailCompliance(name: string, r: Rendered): void {
  if (r.subject === undefined) return;
  if (!r.body.includes(OPT_OUT_MARKER)) {
    throw new Error(`email template "${name}" has no opt-out line (${OPT_OUT_MARKER} ...)`);
  }
}

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/**
 * Substitute {{keys}}, refusing anything it cannot fill.
 *
 * An empty value counts as unresolved, not as an empty substitution. A
 * template that reaches for {{demo_url}} on a lead with no demo must fail
 * loudly here rather than mail someone "here it is: ".
 */
export function interpolate(text: string, ctx: Readonly<Record<string, string>>): string {
  const missing = new Set<string>();
  const out = text.replace(PLACEHOLDER, (_match, key: string) => {
    const value = ctx[key.toLowerCase()];
    if (value === undefined || value.trim() === '') {
      missing.add(key);
      return '';
    }
    return value;
  });
  if (missing.size > 0) {
    throw new Error(`unresolved placeholder(s): ${[...missing].sort().join(', ')}`);
  }
  // A malformed placeholder ("{{ name" or "{name}}") never matches the regex
  // and would sail straight through into a real inbox.
  if (out.includes('{{') || out.includes('}}')) {
    throw new Error('template contains a malformed placeholder (stray {{ or }})');
  }
  return out;
}

/**
 * Plural noun phrase for a category label, for use mid-sentence.
 *
 * The templates previously appended a bare "s", which is wrong for most of
 * the real labels in categories.json: several are adjectives ("Dental",
 * "Optical"), mass nouns ("Clothing", "Fast food") or gerunds ("Pet
 * grooming"), so no suffix rule can fix them. Those get an explicit noun.
 * Everything else follows normal English rules. A blank category produced
 * the memorable "businesss".
 *
 * This lives here rather than in categories.json because it is presentation,
 * and because the scoring code reads those labels for other purposes.
 */
const CATEGORY_PLURAL: Record<string, string> = {
  'fast food': 'fast food places',
  'clothing': 'clothing shops',
  'dental': 'dental clinics',
  'optical': 'optical shops',
  'pet grooming': 'pet groomers',
  'ice cream': 'ice cream shops',
  'beauty salon': 'beauty salons',
  'bike shop': 'bike shops',
  'coffee shop': 'coffee shops',
  'pastry shop': 'pastry shops',
};

export function pluralizeCategory(label: string): string {
  const key = label.trim().toLowerCase();
  if (!key) return 'small businesses';
  const explicit = CATEGORY_PLURAL[key];
  if (explicit) return explicit;
  if (/[^aeiou]y$/.test(key)) return key.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(key)) return key + 'es';
  return key + 's';
}

/** SENDER_NAME and SENDER_EMAIL from settings, when set. */
function senderOverrides(): Record<string, string> {
  const s = settings();
  return {
    ...(s.senderName ? { sender_name: s.senderName } : {}),
    ...(s.senderEmail ? { sender_email: s.senderEmail } : {}),
  };
}

/** Every value a template may reference, lowest precedence first. */
function buildContext(lead: Lead, extra: Record<string, string>): Record<string, string> {
  const areas = loadAreas().areas;
  const category = (lead.category ?? '').trim().toLowerCase();
  return {
    ...(lead as unknown as Record<string, string>),
    area_label: areas[lead.area]?.label ?? lead.area ?? '',
    // Generic, never invented: "business" is true of every lead in the store.
    category_phrase: category || 'business',
    // Already plural and grammatical - templates must NOT append an "s".
    category_plural: pluralizeCategory(lead.category ?? ''),
    page_kind: PAGE_KIND_LABEL[lead.website_kind] ?? '',
    today: today(),
    ...SENDER,
    ...senderOverrides(),
    ...extra,
  };
}

/** Resolve `name` to a file, preferring the variant the lead qualifies for. */
function templateFile(name: string, variant: Variant): string {
  for (const candidate of [`${name}.${variant}.md`, `${name}.md`]) {
    const path = join(TEMPLATE_DIR, candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(
    `no template "${name}" (have: ${availableTemplates().join(', ')})`,
  );
}

export function renderTemplate(
  name: string,
  lead: Lead,
  extra: Record<string, string> = {},
): Rendered {
  // Checked first, before any file is even opened. Every rendering path in
  // the project funnels through here for exactly this reason.
  if (isSuppressed(lead)) {
    throw new Error(
      `refusing to render for "${lead.name}": do_not_contact is set (RA 10173 opt-out)`,
    );
  }

  const raw = readFileSync(templateFile(name, variantFor(lead)), 'utf8')
    .replace(/\r\n/g, '\n');
  const filled = interpolate(raw, buildContext(lead, extra));

  const match = filled.match(/^Subject:\s*(.+)\n+/);
  if (!match) return { body: filled.trim() + '\n' };
  const rendered = {
    subject: match[1]!.trim(),
    body: filled.slice(match[0].length).trim() + '\n',
  };
  assertEmailCompliance(name, rendered);
  return rendered;
}

/**
 * The channel this lead is reachable on, or null.
 *
 * Null for a suppressed lead too, so a caller that forgets to check the
 * opt-out list still cannot address them.
 */
export function pickChannel(lead: Lead): Channel | null {
  if (isSuppressed(lead)) return null;
  for (const slot of CONTACT_PRIORITY) {
    if (slot === 'phone') continue; // a call, not a message - see above
    if ((lead[slot] ?? '').trim() !== '') return slot;
  }
  return null;
}

/** The first-contact template for a channel. */
export function templateForChannel(channel: Channel): string {
  return CHANNEL_TEMPLATE[channel];
}

/** The channel a template is written for, or null if it suits any. */
export function channelForTemplate(name: string): Channel | null {
  return TEMPLATE_CHANNELS[name] ?? null;
}

/** Logical template names, variants collapsed. */
export function availableTemplates(): string[] {
  const names = readdirSync(TEMPLATE_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/(\.(social|bare))?\.md$/, ''));
  return [...new Set(names)].sort();
}
