/**
 * The console's Work Queue routes.
 *
 *   GET  /api/queue?area=         the queue, grouped by what each lead waits on
 *   POST /api/queue/transition    {lead_id, action, url?}  a status move (transitions.ts)
 *   POST /api/queue/verify        {lead_id, answers}       a hand verification
 *   POST /api/queue/build         {lead_id}                scaffold (or adopt) the demo folder
 *   POST /api/queue/pitch         {lead_id}                draft the Tier-2 pitch email
 *   POST /api/queue/record        {lead_id}   job          film the live demo
 *   POST /api/queue/harvest       {lead_id}   job          Instagram photos into research/
 *   POST /api/queue/verify-run    {area}      job          automatic verify, next 40
 *   GET  /demo-files/<slug>/...                            a recording, for preview
 *
 * Every write reads the lead fresh from the store and goes through the same
 * rules as the CLI. Jobs run one at a time, under the cross-process run lock,
 * and the page polls `job` in GET /api/queue.
 */
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { dataPath, loadAreas } from './config.ts';
import { loadCategories } from './config.ts';
import { openStore } from './store.ts';
import { settings } from './settings.ts';
import { rootLogger } from './log.ts';
import { today } from './dates.ts';
import { json, readBody } from './http.ts';
import { resolveStatic, sendFile } from './static-server.ts';
import { SingleJob } from './single-job.ts';
import { acquireRunLock, RunLockHeld, type RunLock } from './run-lock.ts';
import { errorMessage } from './errors.ts';
import { workQueue } from './work-queue.ts';
import { queueView } from './queue-view.ts';
import { ACTIONS, transition } from './transitions.ts';
import { ManualAnswers, hasAnyContact, manualVerifyPatch } from './manual-verify.ts';
import { buildDemoKit, recordLiveDemo, demoSlugFor } from './demo-kit.ts';
import { writePitchDraft } from './pitch-draft.ts';
import { harvestAssets } from './harvest.ts';
import { verifyLeads } from './stages/verify.ts';
import { DEFAULT_CAPS } from './campaign-stages.ts';
import { isSuppressed, type Lead } from './lead.ts';

const job = new SingleJob();

const LeadId = z.object({ lead_id: z.string().trim().min(1, 'lead_id is required').max(200) });
const TransitionBody = LeadId.extend({
  // `scaffolded` is recorded by Build demo, never set by hand.
  action: z.enum(ACTIONS.filter((a) => a !== 'scaffolded') as [string, ...string[]], { error: 'unknown action' }),
  url: z.string().trim().max(2000).optional(),
});
const VerifyBody = LeadId.extend({ answers: ManualAnswers });
const VerifyRunBody = z.object({ area: z.string().trim().min(1, 'choose an area') });

const VERIFIABLE = new Set(['sourced', 'shortlisted', 'needs_manual']);

function invalid(res: ServerResponse, err: z.ZodError): void {
  json(res, 400, {
    error: err.issues.map((i) => `${String(i.path.at(-1) ?? 'value')}: ${i.message}`).join('; '),
    fields: err.issues.map((i) => String(i.path.at(-1) ?? '')),
  });
}

async function findLead(id: string): Promise<Lead | undefined> {
  return (await openStore().all()).find((l) => l.lead_id === id);
}

const areaLabel = (area: string) => loadAreas().areas[area]?.label ?? area;

/** Start a background job under the run lock. Answers 202, or 409 if one is running. */
function startJob(res: ServerResponse, label: string, fn: () => Promise<string>): void {
  if (job.status().running) { json(res, 409, { error: `a job is already running (${job.status().label})` }); return; }
  let lock: RunLock;
  try {
    lock = acquireRunLock(dataPath('pipeline.lock'));
  } catch (err) {
    if (err instanceof RunLockHeld) { json(res, 409, { error: err.message }); return; }
    throw err;
  }
  job.start(label, async () => {
    try {
      return await fn();
    } finally {
      lock.release();
    }
  });
  json(res, 202, { ok: true, job: job.status() });
}

async function getQueue(res: ServerResponse, url: URL): Promise<void> {
  const s = settings();
  const area = url.searchParams.get('area') || undefined;
  const leads = await openStore().all();
  const view = queueView(workQueue(leads, { today: today(), area }), {
    areaLabel, demoRoot: s.demoSitesRoot, draftsDir: dataPath('drafts'), senderEmail: s.senderEmail, exists: existsSync,
  });
  json(res, 200, {
    ...view,
    today: today(),
    area: area ?? '',
    areas: Object.entries(loadAreas().areas).map(([key, a]) => ({ key, label: a.label })),
    job: job.status(),
    setup: {
      senderEmail: Boolean(s.senderEmail),
      portfolio: s.portfolioUrls.length,
      demoRoot: existsSync(`${s.demoSitesRoot}/.claude/launch.json`),
    },
  });
}

async function postTransition(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = TransitionBody.safeParse(await readBody(req));
  if (!body.success) return invalid(res, body.error);
  const lead = await findLead(body.data.lead_id);
  if (!lead) return json(res, 404, { error: 'unknown lead' });
  const r = transition(lead, body.data.action as (typeof ACTIONS)[number], { now: today(), url: body.data.url });
  if ('refusal' in r) return json(res, 400, { error: r.refusal, fields: ['url'] });
  await openStore().update(lead.lead_id, r.patch);
  json(res, 200, { ok: true, patch: r.patch });
}

async function postVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = VerifyBody.safeParse(await readBody(req));
  if (!body.success) return invalid(res, body.error);
  const lead = await findLead(body.data.lead_id);
  if (!lead) return json(res, 404, { error: 'unknown lead' });
  if (!VERIFIABLE.has(lead.status)) return json(res, 400, { error: `lead is "${lead.status}" - already verified` });
  if (!hasAnyContact(body.data.answers)) {
    return json(res, 400, { error: 'enter a website or at least one contact - or Disqualify the lead', fields: ['website_url'] });
  }
  const patch = manualVerifyPatch(lead, body.data.answers, loadCategories());
  await openStore().update(lead.lead_id, patch);
  json(res, 200, { ok: true, patch });
}

async function postBuild(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = LeadId.safeParse(await readBody(req));
  if (!body.success) return invalid(res, body.error);
  const lead = await findLead(body.data.lead_id);
  if (!lead) return json(res, 404, { error: 'unknown lead' });
  // Check the move before touching the disk: no folder for a lead that cannot take it.
  const check = transition(lead, 'scaffolded', { now: today(), slug: demoSlugFor(lead) });
  if ('refusal' in check) return json(res, 400, { error: check.refusal });
  const kit = buildDemoKit(lead);
  const r = transition(lead, 'scaffolded', { now: today(), slug: kit.slug });
  if ('refusal' in r) return json(res, 400, { error: r.refusal });
  await openStore().update(lead.lead_id, r.patch);
  json(res, 200, { ok: true, kit });
}

async function postPitch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = LeadId.safeParse(await readBody(req));
  if (!body.success) return invalid(res, body.error);
  const lead = await findLead(body.data.lead_id);
  if (!lead) return json(res, 404, { error: 'unknown lead' });
  try {
    const draft = writePitchDraft(lead, { dir: dataPath('drafts'), senderEmail: settings().senderEmail, now: today() });
    json(res, 200, { ok: true, draft });
  } catch (err) {
    json(res, 400, { error: errorMessage(err) });
  }
}

async function postJob(req: IncomingMessage, res: ServerResponse, kind: 'record' | 'harvest'): Promise<void> {
  const body = LeadId.safeParse(await readBody(req));
  if (!body.success) return invalid(res, body.error);
  const lead = await findLead(body.data.lead_id);
  if (!lead) return json(res, 404, { error: 'unknown lead' });
  if (isSuppressed(lead)) return json(res, 400, { error: 'lead is flagged do_not_contact' });
  const log = rootLogger().child({ job: kind, lead: lead.lead_id });
  const s = settings();

  if (kind === 'record') {
    if (lead.status !== 'demo_built' || !lead.demo_url) {
      return json(res, 400, { error: 'Record needs a built demo with its live URL - Mark built first' });
    }
    return startJob(res, `record ${lead.name}`, async () => {
      const r = await recordLiveDemo(lead, { videoMs: s.videoMs, log: (m) => log.info(m) });
      if (r.mockupError) log.warn('hero image skipped', { err: r.mockupError });
      return `recorded ${r.videos.length} take(s) for ${lead.name}` +
        (r.mockup ? ', plus a hero image' : ` - hero image skipped: ${r.mockupError}`);
    });
  }

  if (lead.status !== 'scaffolded' || !lead.instagram) {
    return json(res, 400, { error: 'Harvest needs a scaffolded demo and an Instagram handle on the lead' });
  }
  return startJob(res, `harvest ${lead.name}`, async () => {
    const r = await harvestAssets({
      slug: demoSlugFor(lead), ig: lead.instagram, businessName: lead.name,
      websitesRoot: s.demoSitesRoot, apiKey: process.env.GEMINI_API_KEY, log: (m) => log.info(m),
    });
    if (!r.ok) throw new Error(r.message);
    return `harvested ${r.imagesDownloaded.length} photo(s) for ${lead.name}`;
  });
}

async function postVerifyRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = VerifyRunBody.safeParse(await readBody(req));
  if (!body.success) return invalid(res, body.error);
  const { area } = body.data;
  if (!loadAreas().areas[area]) return json(res, 400, { error: `unknown area "${area}"`, fields: ['area'] });
  const log = rootLogger().child({ job: 'verify', area });
  startJob(res, `verify ${areaLabel(area)}`, async () => {
    const r = await verifyLeads({
      area, areaLabel: areaLabel(area), limit: DEFAULT_CAPS.maxVerify, log: (m) => log.info(m),
    });
    return `verified ${r.resolved} of ${r.attempted}; ${r.handoff.length} need you`;
  });
}

/** Handle a Work Queue route. Returns false if the URL is not one of them. */
export async function handleQueueRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { pathname } = url;
  const post = req.method === 'POST';

  if (req.method === 'GET' && pathname.startsWith('/demo-files/')) {
    const file = resolveStatic(settings().demoSitesRoot, pathname.slice('/demo-files'.length));
    // Only the recordings: a demo folder also holds research notes and code.
    if (!file || !/[\\/]public[\\/]demo[\\/][^\\/]+\.(mp4|png)$/.test(file)) {
      json(res, 404, { error: 'not found' });
      return true;
    }
    sendFile(res, file, req.headers.range);
    return true;
  }

  if (pathname === '/api/queue' && req.method === 'GET') { await getQueue(res, url); return true; }
  if (post && pathname === '/api/queue/transition') { await postTransition(req, res); return true; }
  if (post && pathname === '/api/queue/verify') { await postVerify(req, res); return true; }
  if (post && pathname === '/api/queue/build') { await postBuild(req, res); return true; }
  if (post && pathname === '/api/queue/pitch') { await postPitch(req, res); return true; }
  if (post && pathname === '/api/queue/record') { await postJob(req, res, 'record'); return true; }
  if (post && pathname === '/api/queue/harvest') { await postJob(req, res, 'harvest'); return true; }
  if (post && pathname === '/api/queue/verify-run') { await postVerifyRun(req, res); return true; }
  return false;
}
