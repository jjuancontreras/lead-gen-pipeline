/**
 * Business-name normalization for the chain index.
 *
 * The goal: collapse "Jollibee SM North EDSA", "Jollibee - Katipunan Branch"
 * and "JOLLIBEE (Cubao)" onto one key so we can count how many locations a
 * name actually has across Metro Manila.
 *
 * Getting this wrong is silent and expensive in both directions: too
 * aggressive and unrelated independents merge into a fake "chain" and get
 * dropped; too timid and real chains slip through as independents. The
 * leading-token rule below is the main guard - see stripLocationTokens.
 */

/** City / district / landmark words that appear as branch qualifiers. */
const LOCATION_TOKENS = new Set([
  // cities & districts
  'manila', 'quezon', 'qc', 'makati', 'pasig', 'taguig', 'bgc', 'mandaluyong',
  'san juan', 'marikina', 'paranaque', 'las pinas', 'muntinlupa', 'pasay',
  'caloocan', 'valenzuela', 'malabon', 'navotas', 'pateros', 'antipolo',
  'alabang', 'cubao', 'ortigas', 'eastwood', 'greenhills', 'katipunan',
  'kapitolyo', 'poblacion', 'bonifacio', 'malate', 'ermita', 'binondo',
  'divisoria', 'sampaloc', 'sucat', 'bicutan', 'fairview', 'novaliches',
  'commonwealth', 'maginhawa', 'banawe', 'timog', 'espana', 'recto', 'taft',
  // avenues & landmarks used as branch names
  'edsa', 'aurora', 'buendia', 'shaw', 'boni', 'kalayaan', 'congressional',
  'roosevelt', 'balintawak', 'monumento', 'rockwell', 'salcedo', 'legazpi',
  'centris', 'vertis', 'circuit', 'festival', 'southmall',
  // malls & operators
  'sm', 'robinsons', 'ayala', 'glorietta', 'greenbelt', 'megamall', 'podium',
  'trinoma', 'gateway', 'farmers', 'uptown', 'venice', 'estancia',
  'tiendesitas', 'waltermart', 'starmall', 'landmark', 'araneta', 'moa',
  'citymall', 'puregold', 'shangri la', 'market market', 'ali mall',
  // compass qualifiers - "SM North", "Robinsons East" are branch names
  'north', 'south', 'east', 'west',
  'northeast', 'northwest', 'southeast', 'southwest',
  // country qualifiers
  'philippines', 'pilipinas', 'ph',
]);

/**
 * Phrases where a location word is part of the business's actual name rather
 * than a branch qualifier. "Pancit Malabon" is a dish; stripping "malabon"
 * from "Dolora's Hauz of Pancit Malabon" would merge it with unrelated
 * pancit places. Checked as a bigram against the preceding word.
 */
const PROTECTED_BIGRAMS = new Set([
  'pancit malabon', 'pansit malabon', 'manila bay', 'lechon manila',
  'quezon city', 'binondo style',
]);

/** Words that mean "this is a branch of something", strippable anywhere. */
const BRANCH_TOKENS = new Set([
  'branch', 'br', 'outlet', 'store', 'stall', 'kiosk', 'annex', 'satellite',
  'the', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'ltd', 'llc',
]);

/**
 * Names that are too generic to treat as a chain identity even if many
 * places share them. Counting these would drop unrelated independents.
 */
const GENERIC_NAMES = new Set([
  'bakery', 'cafe', 'coffee', 'restaurant', 'canteen', 'carinderia',
  'eatery', 'bar', 'grill', 'store', 'shop', 'salon', 'clinic', 'pharmacy',
  'bakeshop', 'panaderia', 'sari sari store', 'food', 'foodcourt',
  'food court', 'cafeteria', 'kitchen', 'diner', 'catering',
]);

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function basicClean(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Apostrophes close up ("Gerry's" -> "gerrys"); every other non-alphanumeric
    // acts as a separator. Deleting separators instead of spacing them silently
    // welds words together ("Nino-Two" -> "ninotwo") and breaks name matching.
    .replace(/['‘’`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Remove location and branch qualifiers.
 *
 * Location tokens are only stripped when they are NOT the leading token.
 * "Manila Bakery" is its own business and keeps "manila"; "Jollibee Manila"
 * is a branch and loses it. Without this rule, every business named after
 * its own city collapses into a generic stub and gets misread as a chain.
 */
export function stripLocationTokens(cleaned: string): string {
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length === 0) return '';

  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    // two-word location names ("san juan", "las pinas", "market market")
    const pair = i + 1 < words.length ? `${w} ${words[i + 1]}` : null;
    if (pair && i > 0 && LOCATION_TOKENS.has(pair)) { i++; continue; }
    if (BRANCH_TOKENS.has(w)) continue;
    // Keep a location word that belongs to the name itself, not to a branch.
    const withPrev = i > 0 ? `${words[i - 1]} ${w}` : '';
    if (withPrev && PROTECTED_BIGRAMS.has(withPrev)) { kept.push(w); continue; }
    if (i > 0 && LOCATION_TOKENS.has(w)) continue;
    // bare branch numbers: "jollibee 2", "starbucks 145"
    if (i > 0 && /^\d{1,4}$/.test(w)) continue;
    kept.push(w);
  }
  // Never strip a name down to nothing - fall back to the cleaned form.
  const result = kept.join(' ').trim();
  return result.length >= 3 ? result : cleaned;
}

/** Full normalization: the chain-index key for a business name. */
export function normalizeName(name: string): string {
  return stripLocationTokens(basicClean(name));
}

/**
 * Should this normalized name be eligible to count as a chain?
 * Generic and very short names are excluded - many unrelated businesses
 * legitimately share them.
 */
export function isCountableName(normalized: string): boolean {
  if (normalized.length < 3) return false;
  if (GENERIC_NAMES.has(normalized)) return false;
  return true;
}

export const _internals = { LOCATION_TOKENS, BRANCH_TOKENS, GENERIC_NAMES, PROTECTED_BIGRAMS };
