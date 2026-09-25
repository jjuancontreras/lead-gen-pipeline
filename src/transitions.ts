/**
 * Every status move a person can make from the Work Queue, and the rule for
 * each one.
 *
 * The Sheet's `status` column is the pipeline's only state, so every button
 * that changes it goes through here: one place says which moves are legal,
 * what columns they write, and which of them an opted-out business must never
 * receive. Pure - the caller does the store write (and any side effect, like
 * scaffolding a folder, happens before and is merely recorded here).
 */
import { sentPatch } from './mark-sent.ts';
import { INACTIVE, isSuppressed, type Lead, type Status } from './lead.ts';

export const ACTIONS = [
  'queue_demo', 'unqueue', 'scaffolded', 'mark_built', 'set_video', 'pitch_sent', 'nudged',
  'replied', 'meeting', 'won', 'lost', 'nurture', 'disqualify',
] as const;
export type Action = (typeof ACTIONS)[number];

export interface TransitionInput {
  /** Today, in Asia/Manila (dates.ts `today()`). */
  now: string;
  /** mark_built: the live demo URL. set_video: the hosted video URL. */
  url?: string;
  /** scaffolded: the folder the demo was created under. */
  slug?: string;
}

export type TransitionResult = { patch: Partial<Lead> } | { refusal: string };

/** Actions that move a lead toward contact. An opt-out blocks every one. */
const TOWARD_CONTACT: ReadonlySet<Action> = new Set([
  'queue_demo', 'scaffolded', 'mark_built', 'set_video', 'pitch_sent', 'nudged',
]);

/** Which statuses each action may start from. */
const FROM: Record<Action, readonly Status[]> = {
  queue_demo: ['verified'],
  unqueue: ['demo_queued'],
  scaffolded: ['demo_queued'],
  mark_built: ['demo_queued', 'scaffolded'],
  set_video: ['demo_built'],
  pitch_sent: ['demo_built'],
  nudged: ['demo_sent'],
  replied: ['tier1_sent', 'demo_sent'],
  meeting: ['tier1_sent', 'demo_sent', 'replied'],
  won: ['tier1_sent', 'demo_sent', 'replied', 'meeting'],
  lost: ['tier1_sent', 'demo_sent', 'replied', 'meeting'],
  nurture: [
    'shortlisted', 'needs_manual', 'verified', 'demo_queued', 'scaffolded', 'drafted',
    'tier1_sent', 'replied', 'demo_built', 'demo_sent', 'meeting',
  ],
  disqualify: [
    'sourced', 'shortlisted', 'needs_manual', 'verified', 'demo_queued', 'scaffolded', 'drafted',
    'tier1_sent', 'replied', 'demo_built', 'demo_sent', 'meeting',
  ],
};

const isHttpUrl = (u: string | undefined): u is string => {
  if (!u || !/^https?:\/\//i.test(u.trim())) return false;
  try {
    new URL(u.trim());
    return true;
  } catch {
    return false;
  }
};

const refuse = (refusal: string): TransitionResult => ({ refusal });
const move = (patch: Partial<Lead>): TransitionResult => ({ patch });

function patchFor(lead: Lead, action: Action, input: TransitionInput): TransitionResult {
  switch (action) {
    case 'queue_demo': return move({ status: 'demo_queued' });
    case 'unqueue': return move({ status: 'verified' });
    case 'scaffolded':
      return input.slug ? move({ status: 'scaffolded', demo_slug: input.slug }) : refuse('scaffolded needs the demo slug');
    case 'mark_built':
      if (!input.url) return refuse('mark_built needs the live demo URL');
      return isHttpUrl(input.url)
        ? move({ status: 'demo_built', demo_url: input.url.trim() })
        : refuse('the demo URL must be a full http(s) address');
    case 'set_video':
      return isHttpUrl(input.url)
        ? move({ video_url: input.url.trim() })
        : refuse('the video link must be a full http(s) address');
    case 'pitch_sent':
      if (!isHttpUrl(lead.demo_url)) return refuse('no demo URL on the lead - Mark built first');
      if (!isHttpUrl(lead.video_url)) return refuse('no video link on the lead - record and set the video first');
      return move(sentPatch(lead, input.now, 'demo_sent'));
    case 'nudged': {
      const p = sentPatch(lead, input.now, 'demo_sent');
      // A nudge is not first contact: never touch first_contacted_at here.
      return move({ status: p.status, last_contacted_at: p.last_contacted_at, next_action_date: p.next_action_date });
    }
    // An answer, a meeting or a close ends the automatic sequence.
    case 'replied': return move({ status: 'replied', next_action_date: '' });
    case 'meeting': return move({ status: 'meeting', next_action_date: '' });
    case 'won': return move({ status: 'won', next_action_date: '' });
    case 'lost': return move({ status: 'lost', next_action_date: '' });
    case 'nurture': return move({ status: 'nurture', next_action_date: '' });
    case 'disqualify': return move({ status: 'disqualified', next_action_date: '' });
  }
}

export function transition(lead: Lead, action: Action, input: TransitionInput): TransitionResult {
  if (INACTIVE.has(lead.status)) return refuse(`lead is "${lead.status}" - closed out`);
  if (!FROM[action].includes(lead.status)) {
    return refuse(`lead is "${lead.status}"; ${action} needs ${FROM[action].join(' or ')}`);
  }
  if (TOWARD_CONTACT.has(action) && isSuppressed(lead)) {
    return refuse('lead is flagged do_not_contact - it can only be closed out');
  }
  return patchFor(lead, action, input);
}
