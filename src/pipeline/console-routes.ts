/**
 * The console's pipeline routes: the dashboard's data, retry, run, and the
 * site and video previews.
 *
 *   GET  /api/pipeline         rows, counts, job status
 *   POST /api/pipeline/retry   {lead_id, stage}  reset that stage and later ones, rerun
 *   POST /api/pipeline/run     {area, limit}     run an area's demo-ready leads
 *   GET  /sites/<slug>/...     a generated site
 *   GET  /videos/<slug>/...    a recorded walkthrough
 *
 * A retry or run starts in the background and answers 202; the dashboard
 * polls. Only one job runs at a time (409 otherwise).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { dataPath, loadAreas } from '../config.ts';
import { openStore } from '../store.ts';
import { settings } from '../settings.ts';
import { rootLogger } from '../log.ts';
import { json, readBody } from '../http.ts';
import { resolveStatic, sendFile } from '../static-server.ts';
import { PipelineState } from './state.ts';
import { STAGE_NAMES } from './schemas.ts';
import { runPipeline } from './runner.ts';
import { selectForDemo, stageContext } from './leads.ts';
import { dashboardView, SingleJob } from './dashboard.ts';
import type { Lead } from '../lead.ts';

export const RetryBody = z.object({
  lead_id: z.string().trim().min(1, 'lead_id is required').max(200),
  stage: z.enum(STAGE_NAMES, { error: `stage must be one of ${STAGE_NAMES.join(', ')}` }),
});

export const MAX_RUN_LIMIT = 10;
export const RunBody = z.object({
  area: z.string().trim().min(1, 'choose an area'),
  limit: z.number({ error: 'limit must be a number' }).int('limit must be a whole number')
    .min(1, 'limit must be at least 1').max(MAX_RUN_LIMIT, `limit can be at most ${MAX_RUN_LIMIT}`),
});

const job = new SingleJob();
const state = () => new PipelineState(dataPath('pipeline-state.json'));

function invalid(res: ServerResponse, err: z.ZodError): void {
  json(res, 400, { error: err.issues.map((i) => i.message).join('; '), fields: err.issues.map((i) => i.path.join('.')) });
}

function startRun(label: string, leads: readonly Lead[], res: ServerResponse): void {
  const log = rootLogger().child({ job: label });
  const started = job.start(label, async () => {
    await runPipeline({ leads, state: state(), ctx: stageContext(log), store: openStore() });
  });
  if (!started) {
    json(res, 409, { error: `a job is already running (${job.status().label})` });
    return;
  }
  json(res, 202, { ok: true, job: job.status() });
}

/** Handle a pipeline route. Returns false if the URL is not one of them. */
export async function handlePipelineRoute(
  req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const { pathname } = url;

  if (req.method === 'GET' && (pathname.startsWith('/sites/') || pathname.startsWith('/videos/'))) {
    const kind = pathname.startsWith('/sites/') ? 'sites' : 'videos';
    const file = resolveStatic(dataPath(kind), pathname.slice(kind.length + 1));
    if (!file) {
      json(res, 404, { error: 'not found' });
      return true;
    }
    sendFile(res, file, req.headers.range);
    return true;
  }

  if (pathname === '/api/pipeline' && req.method === 'GET') {
    const leads = await openStore().all();
    json(res, 200, {
      ...dashboardView(leads, state().read()),
      job: job.status(),
      sending: settings().sendEmails,
      // How many leads each area could build right now, so the form can say
      // "none ready" before a request is made rather than after.
      areas: Object.entries(loadAreas().areas).map(([key, a]) => ({
        key, label: a.label, ready: selectForDemo(leads, key, MAX_RUN_LIMIT).length,
      })),
      maxRunLimit: MAX_RUN_LIMIT,
    });
    return true;
  }

  if (pathname === '/api/pipeline/retry' && req.method === 'POST') {
    const body = RetryBody.safeParse(await readBody(req));
    if (!body.success) { invalid(res, body.error); return true; }
    const { lead_id: leadId, stage } = body.data;
    if (!state().leadIds().includes(leadId)) {
      json(res, 404, { error: `lead ${leadId} has not been through the pipeline` });
      return true;
    }
    const lead = (await openStore().all()).find((l) => l.lead_id === leadId);
    if (!lead) { json(res, 404, { error: `lead ${leadId} is not in the lead store` }); return true; }
    if (job.status().running) { json(res, 409, { error: `a job is already running (${job.status().label})` }); return true; }
    state().reset(leadId, stage);
    startRun(`retry ${stage} for ${lead.name}`, [lead], res);
    return true;
  }

  if (pathname === '/api/pipeline/run' && req.method === 'POST') {
    const body = RunBody.safeParse(await readBody(req));
    if (!body.success) { invalid(res, body.error); return true; }
    const { area, limit } = body.data;
    if (!loadAreas().areas[area]) { json(res, 400, { error: `unknown area "${area}"`, fields: ['area'] }); return true; }
    const leads = selectForDemo(await openStore().all(), area, limit);
    if (leads.length === 0) {
      json(res, 400, { error: `no verified tier-A leads without a website in ${area} - run a campaign first`, fields: ['area'] });
      return true;
    }
    startRun(`run ${leads.length} lead(s) in ${area}`, leads, res);
    return true;
  }

  return false;
}

