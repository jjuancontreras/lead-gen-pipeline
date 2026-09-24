/**
 * Which leads a pipeline run takes, and the context it runs them with.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { COLUMNS, emptyLead, isSuppressed, type Lead } from '../lead.ts';
import { loadAreas } from '../config.ts';
import { settings } from '../settings.ts';
import { SENDER } from '../outreach.ts';
import type { Logger } from '../log.ts';
import { NO_TRANSPORT, type Mailer } from './mailer.ts';
import type { StageContext } from './stage.ts';

const LEAD_KEYS = new Set<string>(COLUMNS);

/** A fixture business: the identifying columns are required, the rest optional. */
export const FixtureBusiness = z.object({
  lead_id: z.string().min(1),
  name: z.string().trim().min(1),
  category: z.string().trim().min(1),
  area: z.string().min(1),
  has_website: z.enum(['yes', 'no', 'unknown']),
}).catchall(z.string()).superRefine((b, ctx) => {
  for (const key of Object.keys(b)) {
    if (!LEAD_KEYS.has(key)) ctx.addIssue({ code: 'custom', path: [key], message: 'not a lead column' });
  }
});

export const FixtureFile = z.object({
  _note: z.string().optional(),
  businesses: z.array(FixtureBusiness).min(1),
});

export function loadFixtureLeads(path: string): Lead[] {
  const parsed = FixtureFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`${path}: ${first?.path.join('.')}: ${first?.message}`);
  }
  return parsed.data.businesses.map((b) => ({ ...emptyLead(), status: 'verified', ...b }) as Lead);
}

/**
 * Leads the campaign has already verified as tier A with no website - the
 * same pool the scaffold stage draws from - best stage-1 score first.
 */
export function selectForDemo(all: readonly Lead[], area: string, limit: number): Lead[] {
  return all
    .filter((l) => l.area === area && l.tier === 'A' && l.has_website === 'no' && !isSuppressed(l)
      && (l.status === 'verified' || l.status === 'scaffolded'))
    .sort((a, b) => Number(b.osm_score) - Number(a.osm_score))
    .slice(0, limit);
}

/** The run context, from validated settings and the areas config. */
export function stageContext(log: Logger, mailer: Mailer = NO_TRANSPORT): StageContext {
  const s = settings();
  const areas = loadAreas().areas;
  return {
    dataDir: s.dataDir,
    publicBaseUrl: s.publicBaseUrl,
    videoMs: s.videoMs,
    sendEmails: s.sendEmails,
    mailer,
    senderName: s.senderName ?? SENDER.sender_name,
    senderEmail: s.senderEmail,
    areaLabel: (area) => areas[area]?.label ?? area,
    log,
  };
}
