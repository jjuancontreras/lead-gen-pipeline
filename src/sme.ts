/**
 * SME band enforcement.
 *
 * "Small to medium" has two edges. The ceiling keeps out Jollibee; the floor
 * keeps out businesses that cannot pay or do not need a site. A food cart
 * with 4 reviews wastes as much time as a chain does.
 */
import { normalizeName, isCountableName, basicClean, stripLeadingBranchTokens } from './normalize.ts';
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

/**
 * OSM tags that mark a business as branded/franchised/notable.
 *
 * `operator` is deliberately NOT treated as a brand signal. In OSM it
 * routinely holds the sole proprietor, owning family or catering supplier
 * of a single site - `operator="Ivy's Bakery"` on a shop named "Ivy's
 * Bakery" is a self-reference, not a franchise. Measured over the full
 * 20,568-POI corpus, using `operator` alone rejected 200 genuine
 * independents (90 of them in phase-1 categories). Real chains are still
 * caught by `brand`, `brand:wikidata`, the chain-index count, or the
 * manual denylist - `operator` added nothing those don't already cover.
 */
export function brandTagReason(tags: Record<string, string> = {}): RejectReason | null {
  if (tags.brand || tags['brand:wikidata']) return 'brand-tag';
  if (tags.wikidata || tags.wikipedia) return 'wikidata-tag';
  return null;
}

/** Two names extend one another by at most this many extra content words -
 *  past this, a shared prefix is coincidence, not a brand relationship. */
const MAX_EXTRA_HEAD_WORDS = 2;

/**
 * Manual denylist match, checked in BOTH directions but bounded in both.
 *
 * Chains appear under long and short names that normalize apart:
 * "Seattle's Best Coffee" counts 24 locations but "Seattle's Best" counts 4,
 * which falls under the cutoff and would otherwise survive. Matching only
 * forwards ("key starts with entry") misses the short form - hence the
 * reverse check too.
 *
 * Both directions are bounded, not open-ended prefix matches:
 *  - Reverse (entry extends the real name) only fires when the real name
 *    is itself plausibly a brand (2+ words). A single generic stub -
 *    "Old" from "Old Manila" after "manila" is stripped as a location
 *    word, or a business literally named "Coffee" - should never
 *    reverse-match an unrelated long entry ("old spaghetti house",
 *    "coffee bean") just because it happens to be a prefix of one.
 *  - Forward (real name extends the entry) is bounded to a couple of
 *    extra RAW (un-stripped) words past the entry. "Army Navy Burger" and
 *    "Savemore Pharmacy" add one real word to their entry and should
 *    match; "Vikings Bicycle Parts & Accessories" adds three unrelated
 *    words to "vikings" and should not. Raw word count (not the
 *    location-stripped key) is what separates them - by the time
 *    location words are stripped, both a genuine mall qualifier and an
 *    unrelated word like "of" collapse to the same 1-word "extra", so the
 *    bound has to look at the name before that stripping.
 */
export function isManualChain(name: string, denylist: string[]): boolean {
  const key = normalizeName(name);
  const keyWords = key.split(' ').filter(Boolean);
  const raw = stripLeadingBranchTokens(basicClean(name));
  const rawWords = raw.split(' ').filter(Boolean);

  return denylist.some((d) => {
    if (key === d) return true;
    if (keyWords.length >= 2 && d.startsWith(key + ' ')) return true;
    if (raw.startsWith(d + ' ')) {
      const extra = rawWords.length - d.split(' ').filter(Boolean).length;
      if (extra >= 0 && extra <= MAX_EXTRA_HEAD_WORDS) return true;
    }
    return false;
  });
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
  if (brand) return { keep: false, reason: brand, detail: tags.brand ?? tags['brand:wikidata'] ?? 'tagged' };

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
