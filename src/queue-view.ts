/**
 * What the Work Queue page shows for each lead: the columns it needs, plus
 * the one or two facts each group's card turns on (where to look for a
 * verification, whether the recording exists, whether a pitch can be drafted).
 *
 * Filesystem questions arrive as a function, so this stays pure and testable.
 */
import { join } from 'node:path';
import { QUEUE_GROUPS, type QueueGroup, type QueueItem, type WorkQueue } from './work-queue.ts';
import { searchLinks, type SearchLinks } from './manual-verify.ts';
import { demoSlugFor, recordingDir, suggestedVideoUrl } from './demo-kit.ts';
import { pitchDraftPath, pitchRefusal } from './pitch-draft.ts';
import type { Action } from './transitions.ts';
import type { Lead } from './lead.ts';

const CARD_FIELDS = [
  'lead_id', 'name', 'category', 'area', 'tier', 'status', 'osm_score', 'email', 'phone',
  'instagram', 'facebook', 'tiktok', 'website_url', 'demo_slug', 'demo_url', 'video_url',
  'next_action_date', 'last_contacted_at', 'notes',
] as const satisfies readonly (keyof Lead)[];

export type LeadCard = Pick<Lead, (typeof CARD_FIELDS)[number]> & {
  areaLabel: string;
  links?: SearchLinks;
  slug?: string;
  recorded?: boolean;
  suggestedVideoUrl?: string;
  pitch?: { refusal: string | null; drafted: boolean };
};

export interface CardView {
  lead: LeadCard;
  actions: Action[];
  note?: string;
}

export interface QueueEnv {
  areaLabel: (area: string) => string;
  demoRoot: string;
  draftsDir: string;
  senderEmail?: string;
  exists: (path: string) => boolean;
}

function card(item: QueueItem, group: QueueGroup, env: QueueEnv): CardView {
  const l = item.lead;
  const base = Object.fromEntries(CARD_FIELDS.map((k) => [k, l[k]])) as Pick<Lead, (typeof CARD_FIELDS)[number]>;
  const areaLabel = env.areaLabel(l.area);
  const slug = demoSlugFor(l);
  const extra: Partial<LeadCard> = {};
  if (group === 'verify') extra.links = searchLinks(l, areaLabel);
  if (group === 'build' || group === 'record' || group === 'pitch') extra.slug = slug;
  if (group === 'record') {
    extra.recorded = env.exists(join(recordingDir(env.demoRoot, slug), `${slug}-16x9.mp4`));
    extra.suggestedVideoUrl = l.demo_url ? suggestedVideoUrl(l.demo_url, slug) : '';
  }
  if (group === 'pitch') {
    extra.pitch = { refusal: pitchRefusal(l, env.senderEmail), drafted: env.exists(pitchDraftPath(l, env.draftsDir)) };
  }
  return {
    lead: { ...base, areaLabel, ...extra },
    actions: item.actions,
    ...(item.note ? { note: item.note } : {}),
  };
}

export interface QueueView {
  groups: Record<QueueGroup, CardView[]>;
  unverified: number;
  suppressed: number;
}

export function queueView(q: WorkQueue, env: QueueEnv): QueueView {
  const groups = Object.fromEntries(QUEUE_GROUPS.map((g) => [g, q.groups[g].map((i) => card(i, g, env))])) as Record<QueueGroup, CardView[]>;
  return { groups, unverified: q.unverified, suppressed: q.suppressed };
}
