import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadChainIndex, loadCategories, loadManualChains } from '../src/config.ts';
import { chainLocations, applyCeiling } from '../src/sme.ts';
import type { OsmElement } from '../src/overpass.ts';

const index = loadChainIndex();
const config = loadCategories();
const manual = loadManualChains().denylist;

const el = (name: string, tags: Record<string, string> = {}): OsmElement => ({
  type: 'node', id: 1, tags: { name, amenity: 'restaurant', ...tags },
});

const keep = (name: string, tags?: Record<string, string>) =>
  applyCeiling({
    element: el(name, tags), index, config, manualDenylist: manual, maxPhase: 2,
  });

describe('chain index', { skip: index ? false : 'run `npm run chain-index` first' }, () => {
  test('national chains are counted in the hundreds and dropped', () => {
    // Bounds not exact values: OSM shifts between quarterly rebuilds, but an
    // order-of-magnitude drop would mean normalization silently broke.
    for (const [name, floor] of [['Jollibee', 300], ['McDonalds', 200], ['Starbucks', 200]] as const) {
      assert.ok(chainLocations(name, index) > floor, `${name} count too low`);
      assert.equal(keep(name).keep, false, `${name} should be dropped`);
    }
  });

  test('CRITICAL: chains with no brand tag are still caught', () => {
    // This is the case a hand-written denylist fails. None of these carry
    // brand/brand:wikidata/operator in OSM - only location counting finds them.
    const untagged = [
      'Hap Chan', 'Tapa King', 'Shawarma Shack', 'Kowloon House',
      "Gerry's Grill", 'Serenitea', "Italianni's", "David's Salon",
      "Dolora's Hauz of Pancit Malabon",
    ];
    for (const name of untagged) {
      const n = chainLocations(name, index);
      assert.ok(n >= config.sme.chainCutoff, `${name} counted only ${n} locations`);
      const v = keep(name);
      assert.equal(v.keep, false, `${name} survived the ceiling`);
      assert.equal(v.reason, 'chain-index', `${name} dropped for wrong reason: ${v.reason}`);
    }
  });

  test('branch variants collapse onto the same count', () => {
    const base = chainLocations('Jollibee', index);
    for (const v of ['Jollibee SM North EDSA', 'Jollibee (Cubao)', 'Jollibee - Katipunan Branch']) {
      assert.equal(chainLocations(v, index), base, `variant "${v}" did not collapse`);
    }
  });

  test('independents survive the ceiling', () => {
    for (const name of ["Rocha's", 'KopiRoti', "Mason's"]) {
      assert.equal(chainLocations(name, index), 1, `${name} unexpectedly counted`);
      assert.equal(keep(name).keep, true, `${name} was wrongly dropped`);
    }
  });

  test('2-4 branch SMEs are kept - multi-location is not a disqualifier', () => {
    const smes = Object.entries(index!.counts).filter(([, n]) => n >= 2 && n <= 4);
    assert.ok(smes.length > 300, `only ${smes.length} businesses in the 2-4 band`);
    const [name] = smes[0]!;
    assert.equal(keep(name).keep, true, `2-4 branch business "${name}" was dropped`);
  });

  test('generic names never count as a chain', () => {
    for (const g of ['Cafe', 'Bakery', 'Carinderia']) {
      assert.equal(chainLocations(g, index), 1, `generic "${g}" treated as a chain`);
    }
  });
});

describe('ceiling rules independent of the index', () => {
  test('brand and wikidata tags drop a business', () => {
    assert.equal(keep('Some Local Place', { brand: 'Acme' }).reason, 'brand-tag');
    assert.equal(keep('Some Local Place', { 'brand:wikidata': 'Q1' }).reason, 'brand-tag');
    assert.equal(keep('Some Local Place', { wikidata: 'Q123' }).reason, 'wikidata-tag');
  });

  test('operator alone does NOT drop a business - it is a proprietor, not a brand signal', () => {
    // Regression for HIGH #2: in OSM `operator` routinely holds the sole
    // proprietor, owning family or catering supplier of a single site.
    // "Ivy's Bakery" operator="Ivy's Bakery" is a self-reference; measured
    // over the real corpus, treating operator as a chain signal rejected
    // 200 genuine independents.
    assert.equal(keep('Ivy\'s Bakery', { operator: "Ivy's Bakery" }).keep, true);
    assert.equal(keep('Dental Options', { operator: 'Jec Mendoza, DMD' }).keep, true);
    assert.equal(keep('Some Local Place', { operator: 'Acme Corp' }).keep, true);
  });

  test('denylist matches both long and short chain names', () => {
    // "Seattle's Best Coffee" counts 24 locations, but "Seattle's Best"
    // normalizes apart and counts only 4 - under the cutoff. One-directional
    // matching lets the short form through; both directions must be checked.
    for (const name of ["Seattle's Best", "Seattle's Best Coffee", 'Vikings', 'Old Spaghetti House']) {
      assert.equal(keep(name).keep, false, `${name} survived the denylist`);
    }
  });

  test('denylist does not over-match genuine independents', () => {
    for (const name of ['Kohi', 'Gubat', "Fred's Revolucion", 'The Porch']) {
      assert.equal(keep(name).keep, true, `${name} was wrongly denylisted`);
    }
  });

  test('REGRESSION: denylist prefix rules no longer drop unrelated independents (QA HIGH #3)', () => {
    for (const name of [
      'Old Manila', // reverse rule matched "old spaghetti house" via the stub "old"
      'Vikings Bicycle Parts & Accessories', // forward rule matched "vikings"
      'Coffee bean of the north', // forward rule matched "coffee bean"
      'Coffee', 'Family', 'Pancake', 'Army', 'Dads', 'Sambo', 'Rai', 'Chic', // bare stub words
    ]) {
      assert.equal(keep(name).keep, true, `${name} was wrongly denylisted`);
    }
  });

  test('denylist still catches the long/short chain-name variants it exists for', () => {
    for (const name of [
      "Seattle's Best", "Seattle's Best Coffee", 'Vikings', 'Old Spaghetti House',
      'Army Navy Burger', 'Savemore Pharmacy', 'YakiMix Prime', // real-name extensions
    ]) {
      assert.equal(keep(name).keep, false, `${name} should still be caught by the denylist`);
    }
  });

  test('off-category businesses are dropped', () => {
    assert.equal(keep('Random Place', { amenity: 'bank' }).reason, 'off-category');
  });

  test('phase gating hides service categories at phase 1', () => {
    const v = applyCeiling({
      element: el('Cut Above', { amenity: '', shop: 'hairdresser' }),
      index, config, manualDenylist: manual, maxPhase: 1,
    });
    assert.equal(v.keep, false);
    assert.equal(v.reason, 'off-category');
  });

  test('fast food is NOT blanket-dropped - local carinderias qualify', () => {
    // 208 of 1,015 Katipunan independents are amenity=fast_food. The chain
    // index removes the scale problem; dropping the category would discard
    // a fifth of the funnel.
    assert.equal(keep('Litsong Manok ni Sr. Pedro Lokal', { amenity: 'fast_food' }).keep, true);
  });
});
