/** Stage: sweep an area for SME leads. */
import {
  loadAreas, loadCategories, loadManualChains, loadChainIndex, categoryKeysForPhase,
} from '../config.ts';
import { buildCategoryQuery, runOverpass, elementId, elementLatLon } from '../overpass.ts';
import { applyCeiling, stage1Score, chainLocations, categoryKeyOf, type RejectReason } from '../sme.ts';
import { emptyLead, type Lead } from '../lead.ts';
import { openStore } from '../store.ts';
import { registerStage, type StageResult } from '../campaign-stages.ts';

export interface SourceOptions {
  area: string;
  phase?: number;
  limit?: number;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface SourceReport {
  named: number;
  rejects: Record<string, number>;
  kept: Lead[];
  added: number;
  skipped: number;
}

export async function sourceArea(opts: SourceOptions): Promise<SourceReport> {
  const log = opts.log ?? (() => {});
  const areas = loadAreas();
  const area = areas.areas[opts.area];
  if (!area) throw new Error(`Unknown area "${opts.area}"`);

  const config = loadCategories();
  const manual = loadManualChains().denylist;
  const index = loadChainIndex();
  if (!index) throw new Error('No chain-index.json - run `npm run chain-index` first');

  const phase = opts.phase ?? 1;
  const keys = categoryKeysForPhase(config, phase);
  const query = buildCategoryQuery(area.bbox, keys, { timeout: 120, withCenter: true });
  const res = await runOverpass(query, { onAttempt: log });

  const named = res.elements.filter((e) => e.tags?.name);
  const rejects: Record<string, number> = {};
  const kept: Lead[] = [];

  for (const el of named) {
    const verdict = applyCeiling({
      element: el, index, config, manualDenylist: manual, maxPhase: phase,
    });
    if (!verdict.keep) {
      const r = verdict.reason as RejectReason;
      rejects[r] = (rejects[r] ?? 0) + 1;
      continue;
    }
    const tags = el.tags!;
    const name = tags.name!;
    const locations = chainLocations(name, index);
    const catKey = categoryKeyOf(tags, config.categories)!;
    const pos = elementLatLon(el);

    const lead = emptyLead();
    lead.lead_id = elementId(el);
    lead.name = name;
    lead.category = config.categories[catKey]!.label;
    lead.area = opts.area;
    lead.lat = pos ? pos.lat.toFixed(6) : '';
    lead.lng = pos ? pos.lon.toFixed(6) : '';
    lead.maps_url =
      'https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(`${name} ${area.label}`);
    lead.osm_score = String(stage1Score(el, config, locations));
    lead.has_hours = tags.opening_hours ? 'yes' : 'no';
    lead.has_address = tags['addr:street'] ? 'yes' : 'no';
    lead.cuisine = tags.cuisine ?? '';
    lead.chain_locations = String(locations);
    lead.phone = tags.phone ?? tags['contact:phone'] ?? '';
    lead.has_website = 'unknown';
    // An OSM website tag is a hint to check, never a verdict: only 28 of
    // 1,212 Katipunan businesses carry one, and Jollibee carries none.
    lead.website_url = tags.website ?? tags['contact:website'] ?? tags.url ?? '';
    lead.instagram = tags['contact:instagram'] ?? '';
    lead.facebook = tags['contact:facebook'] ?? '';
    lead.email = tags.email ?? tags['contact:email'] ?? '';
    kept.push(lead);
  }

  kept.sort((a, b) => Number(b.osm_score) - Number(a.osm_score));
  const selected = opts.limit ? kept.slice(0, opts.limit) : kept;

  if (opts.dryRun) return { named: named.length, rejects, kept: selected, added: 0, skipped: 0 };
  const { added, skipped } = await openStore().upsert(selected);
  return { named: named.length, rejects, kept: selected, added, skipped };
}

registerStage({
  name: 'source',
  description: 'sweep the area for SME leads',
  consumes: [],
  async run(ctx): Promise<StageResult> {
    const r = await sourceArea({
      area: ctx.area, phase: 1, dryRun: ctx.dryRun, log: ctx.log,
    });
    const dropped = Object.entries(r.rejects)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    return {
      processed: r.kept.length,
      summary:
        `${r.named} named -> ${r.kept.length} in SME band ` +
        `(dropped: ${dropped || 'none'}); ${r.added} new, ${r.skipped} already known`,
    };
  },
});
