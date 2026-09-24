/**
 * The contracts between demo-pipeline stages.
 *
 * Each stage's output is parsed with its schema before it is stored, and
 * parsed again when the next stage reads it. A malformed artifact therefore
 * fails at the boundary that produced it, with the field that is wrong,
 * instead of three stages later as a broken email.
 */
import { z } from 'zod';
import { OPT_OUT_MARKER } from '../outreach.ts';

export const STAGE_NAMES = ['find', 'site', 'video', 'email'] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export const STAGE_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a kebab-case slug');
const httpUrl = z.url().refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL');

/** find -> site: a real business with no website, and enough to build a page from. */
export const FoundLead = z.object({
  lead_id: z.string().min(1),
  slug,
  name: z.string().trim().min(1),
  category: z.string().trim().min(1),
  area: z.string().min(1),
  areaLabel: z.string().min(1),
  cuisine: z.string(),
  phone: z.string(),
  email: z.string(),
  instagram: z.string(),
  facebook: z.string(),
  tiktok: z.string(),
  mapsUrl: z.union([httpUrl, z.literal('')]),
  lat: z.string(),
  lng: z.string(),
});
export type FoundLead = z.infer<typeof FoundLead>;

/** site -> video: a static page on disk, and where it will be linked from. */
export const SiteArtifact = z.object({
  slug,
  dir: z.string().min(1),
  indexPath: z.string().min(1),
  url: httpUrl,
  bytes: z.number().int().positive(),
});
export type SiteArtifact = z.infer<typeof SiteArtifact>;

/** video -> email: a playable file with a real duration. */
export const VideoArtifact = z.object({
  path: z.string().min(1),
  url: httpUrl,
  durationMs: z.number().positive('video has no duration'),
  bytes: z.number().int().positive('video file is empty'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type VideoArtifact = z.infer<typeof VideoArtifact>;

/** email: the draft a person reads and sends. `sent` is false unless a transport sent it. */
export const EmailDraft = z.object({
  path: z.string().min(1),
  to: z.email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  siteUrl: httpUrl,
  videoUrl: httpUrl,
  sent: z.boolean(),
}).superRefine((d, ctx) => {
  const need: [string, string][] = [
    [d.siteUrl, 'the site link'],
    [d.videoUrl, 'the video link'],
    [OPT_OUT_MARKER, 'the opt-out line'],
  ];
  for (const [text, what] of need) {
    if (!d.body.includes(text)) ctx.addIssue({ code: 'custom', path: ['body'], message: `missing ${what}` });
  }
  if (/\{\{|\}\}/.test(d.subject + d.body)) {
    ctx.addIssue({ code: 'custom', path: ['body'], message: 'contains an unfilled {{placeholder}}' });
  }
});
export type EmailDraft = z.infer<typeof EmailDraft>;

export const STAGE_OUTPUT = {
  find: FoundLead,
  site: SiteArtifact,
  video: VideoArtifact,
  email: EmailDraft,
} as const;

export interface StageOutputs {
  find: FoundLead;
  site: SiteArtifact;
  video: VideoArtifact;
  email: EmailDraft;
}

export const StageEntry = z.object({
  status: z.enum(STAGE_STATUSES),
  attempts: z.number().int().nonnegative(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  output: z.unknown().optional(),
});
export type StageEntry = z.infer<typeof StageEntry>;

export const LeadStages = z.object({
  find: StageEntry.optional(),
  site: StageEntry.optional(),
  video: StageEntry.optional(),
  email: StageEntry.optional(),
});
export type LeadStages = z.infer<typeof LeadStages>;

export const StateFile = z.object({
  version: z.literal(1),
  leads: z.record(z.string(), LeadStages),
});
export type StateFile = z.infer<typeof StateFile>;

export const PENDING: StageEntry = Object.freeze({ status: 'pending', attempts: 0 });
