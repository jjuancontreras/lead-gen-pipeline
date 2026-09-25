/**
 * The Work Queue: every lead that is waiting on you, grouped by what you owe
 * it.
 *
 * Machines prepare, you craft. Discovery, drafting and scheduling run on their
 * own; this is the list of decisions and hand work they leave behind, in the
 * order a lead meets them. Pure over Lead records - the console renders it,
 * and every button on it goes through `transitions.ts`.
 */
import { isFollowUpDue } from './outreach-policy.ts';
import { isSuppressed, type Lead } from './lead.ts';
import type { Action } from './transitions.ts';

export const QUEUE_GROUPS = [
  'verify', 'choose', 'build', 'record', 'pitch', 'send', 'followup', 'conversations',
] as const;
export type QueueGroup = (typeof QUEUE_GROUPS)[number];

export interface QueueItem {
  lead: Lead;
  /** Status moves offered on this card, primary first. */
  actions: Action[];
  note?: string;
}

export interface WorkQueue {
  groups: Record<QueueGroup, QueueItem[]>;
  /** Sourced leads nobody has verified yet - too many to list, so counted. */
  unverified: number;
  /** Opted-out leads kept off every list. */
  suppressed: number;
}

export interface QueueOptions {
  today: string;
  area?: string;
}

const isDemoFollowUpDue = (l: Lead, today: string): boolean =>
  l.status === 'demo_sent' && l.next_action_date !== '' && l.next_action_date <= today;

/** The group a lead belongs to, or null if nothing is waiting on you. */
function place(l: Lead, today: string): Omit<QueueItem, 'lead'> & { group: QueueGroup } | null {
  switch (l.status) {
    case 'needs_manual':
    case 'shortlisted':
      return { group: 'verify', actions: ['disqualify'] };
    case 'verified':
      // Tier B is volume: the campaign's outreach stage drafts those on its own.
      return l.tier === 'A' ? { group: 'choose', actions: ['queue_demo', 'nurture', 'disqualify'] } : null;
    case 'demo_queued':
      return { group: 'build', actions: ['unqueue'], note: 'Build demo scaffolds the folder and its BUILD-PROMPT.' };
    case 'scaffolded':
      return { group: 'build', actions: ['mark_built'], note: 'Run /demo-site-build, deploy it, then Mark built with the live URL.' };
    case 'demo_built':
      return l.video_url
        ? { group: 'pitch', actions: ['pitch_sent'] }
        : { group: 'record', actions: ['set_video'], note: 'Record the walkthrough, redeploy so the video is live, then set its link.' };
    case 'drafted':
      return { group: 'send', actions: [], note: 'Send it from the draft file, then Mark as sent.' };
    case 'tier1_sent':
      return isFollowUpDue(l, today)
        ? { group: 'followup', actions: ['replied', 'lost'], note: 'Due: `npm run draft` writes the next follow-up.' }
        : { group: 'conversations', actions: ['replied', 'meeting', 'lost'] };
    case 'demo_sent':
      return isDemoFollowUpDue(l, today)
        ? { group: 'followup', actions: ['nudged', 'replied', 'lost'], note: 'Due: send a short personal nudge about the demo, then mark it.' }
        : { group: 'conversations', actions: ['replied', 'meeting', 'lost'] };
    case 'replied':
      return { group: 'conversations', actions: ['meeting', 'won', 'lost'] };
    case 'meeting':
      return { group: 'conversations', actions: ['won', 'lost', 'nurture'] };
    default:
      return null;
  }
}

export function workQueue(leads: readonly Lead[], opts: QueueOptions): WorkQueue {
  const inArea = leads.filter((l) => !opts.area || l.area === opts.area);
  const groups = Object.fromEntries(QUEUE_GROUPS.map((g) => [g, [] as QueueItem[]])) as Record<QueueGroup, QueueItem[]>;
  let suppressed = 0;

  const ranked = [...inArea].sort((a, b) => Number(b.osm_score) - Number(a.osm_score));
  for (const lead of ranked) {
    const spot = place(lead, opts.today);
    if (!spot) continue;
    if (isSuppressed(lead)) { suppressed++; continue; }
    const { group, ...item } = spot;
    groups[group].push({ lead, ...item });
  }

  return {
    groups,
    unverified: inArea.filter((l) => l.status === 'sourced').length,
    suppressed,
  };
}
