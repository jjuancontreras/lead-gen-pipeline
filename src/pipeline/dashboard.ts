/**
 * What the console's pipeline dashboard shows, and the one job it may run.
 */
import type { Lead } from '../lead.ts';
import { errorMessage } from './runner.ts';
import {
  STAGE_NAMES, STAGE_OUTPUT, STAGE_STATUSES,
  type StageName, type StageStatus, type StateFile,
} from './schemas.ts';

export interface StageCell {
  status: StageStatus;
  attempts: number;
  error?: string;
  finishedAt?: string;
}

export interface DashboardRow {
  lead_id: string;
  name: string;
  category: string;
  area: string;
  email: string;
  stages: Record<StageName, StageCell>;
  /** Previews, present once the stage that makes them is done. */
  preview: {
    siteUrl?: string;
    videoUrl?: string;
    email?: { to: string; subject: string; body: string; sent: boolean };
  };
}

export interface DashboardView {
  rows: DashboardRow[];
  counts: Record<StageName, Record<StageStatus, number>>;
}

/** Local preview paths: the console serves `<data dir>/sites` and `/videos`. */
const localPath = (url: string, kind: 'sites' | 'videos'): string => {
  const at = url.indexOf(`/${kind}/`);
  return at >= 0 ? url.slice(at) : url;
};

export function dashboardView(leads: readonly Lead[], state: StateFile): DashboardView {
  const byId = new Map(leads.map((l) => [l.lead_id, l]));
  const counts = Object.fromEntries(STAGE_NAMES.map((s) => [
    s, Object.fromEntries(STAGE_STATUSES.map((st) => [st, 0])),
  ])) as DashboardView['counts'];

  const rows = Object.entries(state.leads).map(([id, stages]): DashboardRow => {
    const lead = byId.get(id);
    const cells = Object.fromEntries(STAGE_NAMES.map((s) => {
      const e = stages[s];
      const cell: StageCell = {
        status: e?.status ?? 'pending',
        attempts: e?.attempts ?? 0,
        ...(e?.error ? { error: e.error } : {}),
        ...(e?.finishedAt ? { finishedAt: e.finishedAt } : {}),
      };
      counts[s][cell.status]++;
      return [s, cell];
    })) as Record<StageName, StageCell>;

    const site = STAGE_OUTPUT.site.safeParse(stages.site?.output);
    const video = STAGE_OUTPUT.video.safeParse(stages.video?.output);
    const email = STAGE_OUTPUT.email.safeParse(stages.email?.output);
    return {
      lead_id: id,
      name: lead?.name ?? id,
      category: lead?.category ?? '',
      area: lead?.area ?? '',
      email: lead?.email ?? '',
      stages: cells,
      preview: {
        ...(cells.site.status === 'done' && site.success ? { siteUrl: localPath(site.data.url, 'sites') } : {}),
        ...(cells.video.status === 'done' && video.success ? { videoUrl: localPath(video.data.url, 'videos') } : {}),
        ...(cells.email.status === 'done' && email.success ? {
          email: { to: email.data.to, subject: email.data.subject, body: email.data.body, sent: email.data.sent },
        } : {}),
      },
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, counts };
}

export interface JobStatus {
  running: boolean;
  label?: string;
  startedAt?: string;
  lastError?: string;
}

/**
 * One pipeline job at a time. Two runs writing one state file would each
 * read-modify-write it, and the later write would drop the earlier one's
 * progress; the console refuses the second request instead.
 */
export class SingleJob {
  private current: JobStatus = { running: false };

  status(): JobStatus {
    return { ...this.current };
  }

  /** Start `fn` in the background. False if a job is already running. */
  start(label: string, fn: () => Promise<void>): boolean {
    if (this.current.running) return false;
    this.current = { running: true, label, startedAt: new Date().toISOString() };
    void fn().then(
      () => { this.current = { running: false }; },
      (err: unknown) => { this.current = { running: false, lastError: errorMessage(err) }; },
    );
    return true;
  }
}
