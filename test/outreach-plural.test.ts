import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluralizeCategory } from '../src/outreach.ts';
import { loadCategories } from '../src/config.ts';

test('every real category label pluralizes to real English', () => {
  // The templates used to append a bare "s", producing "bakerys",
  // "clothings", "dentals" and - for a blank category - "businesss",
  // in the second sentence of every cold email.
  const bad = /(ys|ss s|[^s]ss)$|^businesss$/;
  for (const def of Object.values(loadCategories().categories)) {
    const out = pluralizeCategory(def.label);
    assert.doesNotMatch(out, bad, `"${def.label}" -> "${out}"`);
    assert.ok(out.length > 2, `"${def.label}" -> "${out}"`);
  }
});

test('known-awkward labels get a real noun, not a suffix', () => {
  const cases: [string, string][] = [
    ['Bakery', 'bakeries'],
    ['Pharmacy', 'pharmacies'],
    ['Clothing', 'clothing shops'],
    ['Dental', 'dental clinics'],
    ['Optical', 'optical shops'],
    ['Pet grooming', 'pet groomers'],
    ['Fast food', 'fast food places'],
    ['Ice cream', 'ice cream shops'],
    ['Restaurant', 'restaurants'],
    ['Cafe', 'cafes'],
  ];
  for (const [label, want] of cases) {
    assert.equal(pluralizeCategory(label), want, label);
  }
});

test('a blank category never yields "businesss"', () => {
  for (const v of ['', '   ']) {
    assert.equal(pluralizeCategory(v), 'small businesses');
  }
});
