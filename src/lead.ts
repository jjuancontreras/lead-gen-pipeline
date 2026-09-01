/**
 * The Lead record. Column order here IS the Google Sheet column order -
 * keep them in sync, and only ever append new columns at the end of a group.
 */

export const STATUSES = [
  'sourced', 'shortlisted', 'verified', 'tier1_sent', 'replied',
  'demo_built', 'demo_sent', 'meeting',
  'won', 'lost', 'nurture', 'disqualified',
] as const;
export type Status = (typeof STATUSES)[number];

/** Terminal or parked states - the orchestrator never advances these. */
export const INACTIVE: ReadonlySet<string> = new Set([
  'won', 'lost', 'nurture', 'disqualified',
]);

export type WebsiteKind =
  | 'standalone' | 'free_host' | 'facebook' | 'instagram' | 'tiktok'
  | 'linktree' | 'delivery_app' | 'marketplace' | 'none' | '';

export type Tier = 'A' | 'B' | 'C' | '';

export interface Lead {
  // identity
  lead_id: string;          // "node/123456" - stable OSM id, free to store
  name: string;
  category: string;
  area: string;
  lat: string;
  lng: string;
  maps_url: string;
  // stage 1 (OSM signals)
  osm_score: string;
  has_hours: string;
  has_address: string;
  cuisine: string;
  chain_locations: string;
  // verification
  has_website: string;      // yes | no | unknown
  website_url: string;
  website_kind: WebsiteKind;
  verify_method: string;    // auto | manual | ''
  verify_confidence: string;
  // contacts, in priority order: email -> phone -> IG -> FB -> TikTok
  email: string;
  phone: string;
  instagram: string;
  facebook: string;
  tiktok: string;
  // quality
  rating: string;
  review_count: string;
  ig_followers: string;
  photo_source: string;
  photo_count: string;
  // pipeline
  status: Status;
  tier: Tier;
  next_action_date: string;
  channel_used: string;
  first_contacted_at: string;
  last_contacted_at: string;
  // delivery
  demo_slug: string;
  demo_url: string;
  video_url: string;
  mockup_url: string;
  outcome: string;
  notes: string;
  do_not_contact: string;   // any non-empty value suppresses all outreach
}

export const COLUMNS: (keyof Lead)[] = [
  'lead_id', 'name', 'category', 'area', 'lat', 'lng', 'maps_url',
  'osm_score', 'has_hours', 'has_address', 'cuisine', 'chain_locations',
  'has_website', 'website_url', 'website_kind', 'verify_method', 'verify_confidence',
  'email', 'phone', 'instagram', 'facebook', 'tiktok',
  'rating', 'review_count', 'ig_followers', 'photo_source', 'photo_count',
  'status', 'tier', 'next_action_date', 'channel_used',
  'first_contacted_at', 'last_contacted_at',
  'demo_slug', 'demo_url', 'video_url', 'mockup_url',
  'outcome', 'notes', 'do_not_contact',
];

export function emptyLead(): Lead {
  const l = Object.fromEntries(COLUMNS.map((c) => [c, ''])) as unknown as Lead;
  l.status = 'sourced';
  return l;
}

/** Outreach suppression. Checked before every message-rendering stage. */
export function isSuppressed(lead: Lead): boolean {
  const v = (lead.do_not_contact ?? '').trim().toLowerCase();
  return v !== '' && v !== 'no' && v !== 'false' && v !== '0';
}

export function toRow(lead: Lead): string[] {
  return COLUMNS.map((c) => String(lead[c] ?? ''));
}

export function fromRow(row: string[]): Lead {
  const l = emptyLead();
  COLUMNS.forEach((c, i) => {
    (l as unknown as Record<string, string>)[c] = row[i] ?? '';
  });
  return l;
}
