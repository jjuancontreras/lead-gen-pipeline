/**
 * Verifying a lead by hand: what a person found, turned into the columns the
 * pipeline runs on.
 *
 * Shared by `npm run worklist -- --ingest` (answers typed into a markdown
 * file) and the Work Queue's verify form, so a lead verified either way gets
 * the same website classification, the same score and the same tier.
 */
import { z } from 'zod';
import { classifyWebsite } from './website.ts';
import { stage2 } from './score.ts';
import type { CategoriesConfig } from './config.ts';
import type { Lead } from './lead.ts';

const CONTACT_FIELDS = ['website_url', 'email', 'phone', 'instagram', 'facebook', 'tiktok'] as const;
const EXTRA_FIELDS = ['rating', 'review_count', 'ig_followers', 'photo_count', 'notes'] as const;
type Field = (typeof CONTACT_FIELDS)[number] | (typeof EXTRA_FIELDS)[number];

export type Answers = Partial<Record<Field, string>>;

const text = (max: number) => z.string().trim().max(max).optional();
const wholeNumber = z.string().trim().optional().refine((v) => !v || /^\d{1,9}$/.test(v), 'a whole number');

/** The verify form, validated. Blank means "not found". */
export const ManualAnswers = z.object({
  website_url: text(500),
  email: z.string().trim().optional().refine((v) => !v || z.email().safeParse(v).success, 'not a valid email address'),
  phone: text(40),
  instagram: text(200),
  facebook: text(300),
  tiktok: text(200),
  rating: z.string().trim().optional()
    .refine((v) => !v || (/^\d(\.\d)?$/.test(v) && Number(v) <= 5), 'rating is 0 to 5, like 4.6'),
  review_count: wholeNumber,
  ig_followers: wholeNumber,
  photo_count: wholeNumber,
  notes: text(1000),
}).strict();

export interface SearchLinks { maps: string; web: string; facebook: string; instagram: string }

/**
 * Where a person looks to verify a lead by hand - prebuilt, so a browser
 * session is mechanical rather than exploratory.
 */
export function searchLinks(lead: Pick<Lead, 'name' | 'maps_url'>, areaLabel: string): SearchLinks {
  const q = encodeURIComponent;
  return {
    maps: lead.maps_url || `https://www.google.com/maps/search/?api=1&query=${q(`${lead.name} ${areaLabel}`)}`,
    web: `https://www.google.com/search?q=${q(`"${lead.name}" ${areaLabel}`)}`,
    facebook: `https://www.facebook.com/search/top?q=${q(`${lead.name} ${areaLabel}`)}`,
    instagram: `https://www.instagram.com/explore/search/keyword/?q=${q(lead.name)}`,
  };
}

/** At least a website or one contact channel - otherwise nothing was found. */
export const hasAnyContact = (a: Answers): boolean =>
  CONTACT_FIELDS.some((k) => (a[k] ?? '').trim() !== '');

/** The patch a hand verification writes. Blank answers keep existing values. */
export function manualVerifyPatch(lead: Lead | undefined, a: Answers, config: CategoriesConfig): Partial<Lead> {
  const verdict = classifyWebsite(a.website_url);
  const filled = Object.fromEntries(
    [...CONTACT_FIELDS, ...EXTRA_FIELDS]
      .filter((k) => k !== 'website_url' && (a[k] ?? '') !== '')
      .map((k) => [k, a[k]!]),
  ) as Partial<Lead>;
  const found: Partial<Lead> = {
    website_url: a.website_url ?? '',
    website_kind: verdict.kind,
    has_website: verdict.isStandalone ? 'yes' : 'no',
    verify_method: 'manual',
    verify_confidence: 'high',
    ...filled,
  };
  // Score on the merged record so tiering sees what was already known too.
  const scored = stage2({ ...(lead ?? {}), ...found } as Lead, config);
  const notes = [found.notes, scored.reasons.join('; ')].filter(Boolean).join(' | ');
  return {
    ...found,
    tier: scored.tier,
    status: scored.status,
    ...(notes ? { notes } : {}),
  };
}
