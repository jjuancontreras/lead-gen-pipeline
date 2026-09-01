/**
 * SME band enforcement.
 *
 * "Small to medium" has two edges. The ceiling keeps out Jollibee; the floor
 * keeps out businesses that cannot pay or do not need a site. A food cart
 * with 4 reviews wastes as much time as a chain does.
 */
import { normalizeName, isCountableName } from './normalize.ts';
import type { CategoriesConfig, ChainIndex, CategoryDef } from './config.ts';
import type { OsmElement } from './overpass.ts';

export type RejectReason =
  | 'chain-index' | 'brand-tag' | 'wikidata-tag' | 'manual-denylist'
  | 'off-category';

export interface Verdict {
  keep: boolean;
  reason?: RejectReason;
  detail?: string;
}

/** Metro-wide location count for a name. Absent from the index means 1. */
export function chainLocations(name: string, index: ChainIndex | null): number {
  if (!index) return 1;
  const key = normalizeName(name);
  if (!isCountableName(key)) return 1;
  return index.counts[key] ?? 1;
}

/** OSM tags that mark a business as branded/franchised/notable. */
export function brandTagReason(tags: Record<string, string> = {}): RejectReason | null {
  if (tags.brand || tags['brand:wikidata'] || tags.operator) return 'brand-tag';
  if (tags.wikidata || tags.wikipedia) return 'wikidata-tag';
  return null;
}

/**
 * Manual denylist match, checked in BOTH directions.
 *
 * Chains appear under long and short names that normalize apart:
 * "Seattle's Best Coffee" counts 24 locations but "Seattle's Best" counts 4,
 * which falls under the cutoff and would otherwise survive. Matching only
 * forwards ("key starts with entry") misses the short form.
 */
export function isManualChain(name: string, denylist: string[]): boolean {
  const key = normalizeName(name);
  return denylist.some(
    (d) => key === d || key.startsWith(d + ' ') || d.startsWith(key + ' '),
  );
}

/** The OSM category key ("amenity=cafe") for an element, if it has one. */
export function categoryKeyOf(
  tags: Record<string, string> = {},
  categories: Record<string, CategoryDef>,
): string | null {
  for (const k of ['amenity', 'shop', 'leisure']) {
    const v = tags[k];
    if (v && categories[`${k}=${v}`]) return `${k}=${v}`;
  }
  return null;
}

export interface CeilingInput {
  element: OsmElement;
  index: ChainIndex | null;
  config: CategoriesConfig;
  manualDenylist: string[];
  maxPhase: number;
}

/**
 * The source-time ceiling: everything decidable from OSM alone.
 * Review-count and follower ceilings are applied later, post-verification.
 */
export function applyCeiling(input: CeilingInput): Verdict {
  const { element, index, config, manualDenylist, maxPhase } = input;
  const tags = element.tags ?? {};
  const name = tags.name ?? '';

  const catKey = categoryKeyOf(tags, config.categories);
  if (!catKey) return { keep: false, reason: 'off-category' };
  const def = config.categories[catKey]!;
  if (def.phase > maxPhase) {
    return { keep: false, reason: 'off-category', detail: `phase ${def.phase}` };
  }

  const brand = brandTagReason(tags);
  if (brand) return { keep: false, reason: brand, detail: tags.brand ?? tags.operator ?? 'tagged' };

  if (isManualChain(name, manualDenylist)) {
    return { keep: false, reason: 'manual-denylist' };
  }

  const locations = chainLocations(name, index);
  if (locations >= config.sme.chainCutoff) {
    return { keep: false, reason: 'chain-index', detail: `${locations} locations` };
  }

  return { keep: true };
}

/**
 * Stage-1 score, from OSM signals only. Decides who is worth the cost of
 * browser verification - it is a ranking, not a qualification.
 */
export function stage1Score(
  element: OsmElement,
  config: CategoriesConfig,
  locations: number,
): number {
  const tags = element.tags ?? {};
  const catKey = categoryKeyOf(tags, config.categories);
  let score = catKey ? config.categories[catKey]!.weight : 0;

  // Detail signals: an actively-maintained pin is a real, findable business.
  if (tags.opening_hours) score += 4;
  if (tags['addr:street']) score += 3;
  if (tags.phone || tags['contact:phone']) score += 3;
  if (tags.cuisine) score += 2;
  if (tags['addr:housenumber']) score += 1;

  // 2-4 branches is the sweet spot: growing, has budget, needs a real site.
  const { multiBranchBonusMin: lo, multiBranchBonusMax: hi } = config.sme;
  if (locations >= lo && locations <= hi) score += 5;

  // Already lists a website in OSM - weak signal, but worth deprioritising
  // since verification will probably disqualify them anyway.
  if (tags.website || tags['contact:website'] || tags.url) score -= 6;

  return score;
}
