/** Stage: resolve leads on Maps and decide whether they have a real website. */
import { launch, fetchPlace, jitter } from '../fetcher.ts';
import { classifyWebsite } from '../website.ts';
import { stage2 } from '../score.ts';
import { openStore } from '../store.ts';
import { loadCategories } from '../config.ts';
import { registerStage, type StageResult } from '../campaign-stages.ts';
import type { Lead } from '../lead.ts';

export interface VerifyOptions {
  area: string;
  areaLabel: string;
  limit: number;
  dryRun?: boolean;
  paceMs?: number;
  headed?: boolean;
  log?: (msg: string) => void;
}

export interface VerifyReport {
  attempted: number;
  resolved: number;
  tiers: Record<string, number>;
  statuses: Record<string, number>;
  handoff: { lead: Lead; reason: string }[];
}

export async function verifyLeads(opts: VerifyOptions): Promise<VerifyReport> {
  const log = opts.log ?? (() => {});
  const store = openStore();
  const config = loadCategories();
  const pace = opts.paceMs ?? 12_000;

  const pool = (await store.all())
    .filter((l) => l.area === opts.area && (l.status === 'shortlisted' || l.status === 'sourced'))
    .sort((a, b) => Number(b.osm_score) - Number(a.osm_score))
    .slice(0, opts.limit);

  const report: VerifyReport = {
    attempted: pool.length, resolved: 0, tiers: {}, statuses: {}, handoff: [],
  };
  if (pool.length === 0) return report;

  const browser = await launch(!opts.headed);
  try {
    for (const [i, lead] of pool.entries()) {
      const res = await fetchPlace(browser, { name: lead.name, area: opts.areaLabel });

      if (!res.ok) {
        const reason = `${res.reason}${res.detail ? ' - ' + res.detail : ''}`;
        report.handoff.push({ lead, reason });
        // Park non-transient failures so they stop consuming the verify
        // budget on every future run. An ambiguous match or a consent wall
        // will not resolve itself by trying again; only a hard error will.
        if (!opts.dryRun && res.reason !== 'error') {
          await store.update(lead.lead_id, {
            status: 'needs_manual',
            notes: `automated verification could not resolve this: ${reason}`,
          });
        }
        log(`${i + 1}/${pool.length} ${lead.name.slice(0, 32).padEnd(33)} -> manual (${res.reason})`);
      } else {
        const f = res.facts;
        const verdict = classifyWebsite(f.websiteUrl);
        const patch: Partial<Lead> = {
          website_url: f.websiteUrl ?? '',
          website_kind: verdict.kind,
          has_website: verdict.isStandalone ? 'yes' : 'no',
          verify_method: 'auto',
          verify_confidence: res.confidence,
          phone: f.phone ?? lead.phone,
          rating: f.rating ?? '',
          review_count: f.reviewCount ?? '',
        };
        const scored = stage2({ ...lead, ...patch } as Lead, config);
        patch.tier = scored.tier;
        patch.status = scored.status;
        patch.notes = scored.reasons.join('; ');

        if (!opts.dryRun) await store.update(lead.lead_id, patch);
        report.resolved++;
        report.tiers[scored.tier || '-'] = (report.tiers[scored.tier || '-'] ?? 0) + 1;
        report.statuses[scored.status] = (report.statuses[scored.status] ?? 0) + 1;
        const kind = verdict.kind === 'none' ? 'no web presence' : verdict.kind;
        log(
          `${i + 1}/${pool.length} ${lead.name.slice(0, 32).padEnd(33)} ` +
          `${String(kind).padEnd(14)} ${(scored.tier || '-').padEnd(2)} ${scored.status}`,
        );
      }
      if (i < pool.length - 1) await jitter(pace);
    }
  } finally {
    await browser.close();
  }
  return report;
}

registerStage({
  name: 'verify',
  description: 'resolve on Maps, classify website, tier',
  consumes: ['sourced', 'shortlisted'],
  async run(ctx): Promise<StageResult> {
    const r = await verifyLeads({
      area: ctx.area, areaLabel: ctx.areaLabel, limit: ctx.caps.maxVerify,
      dryRun: ctx.dryRun, log: ctx.log,
    });
    if (r.attempted === 0) {
      return { processed: 0, summary: 'nothing to verify' };
    }
    const tiers = (['A', 'B', 'C'] as const).map((t) => `${t}:${r.tiers[t] ?? 0}`).join(' ');
    return {
      processed: r.resolved,
      summary: `${r.resolved}/${r.attempted} resolved automatically  tiers ${tiers}  ${r.handoff.length} need manual`,
      handoff: r.handoff,
    };
  },
});
