import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, isCountableName, basicClean } from '../src/normalize.ts';

test('collapses branch variants of the same chain onto one key', () => {
  const variants = [
    'Jollibee',
    'Jollibee SM North EDSA',
    'JOLLIBEE (Cubao)',
    'Jollibee - Katipunan Branch',
    'Jollibee Katipunan',
    'Jollibee 2',
    'Jollibee, Trinoma',
  ];
  for (const v of variants) {
    assert.equal(normalizeName(v), 'jollibee', `failed on: ${v}`);
  }
});

test('keeps a leading location word - "Manila Bakery" is not a branch', () => {
  // This is the guard that stops unrelated independents collapsing into
  // a generic stub and being misread as a chain.
  assert.equal(normalizeName('Manila Bakery'), 'manila bakery');
  assert.equal(normalizeName('Marikina Universal Bakery'), 'marikina universal bakery');
  assert.equal(normalizeName('Quezon Avenue Grill'), 'quezon avenue grill');
});

test('strips a trailing location word', () => {
  assert.equal(normalizeName('Universal Bakery Marikina'), 'universal bakery');
  assert.equal(normalizeName('Tapa King Ortigas'), 'tapa king');
});

test('handles two-word location names', () => {
  assert.equal(normalizeName('Starbucks San Juan'), 'starbucks');
  assert.equal(normalizeName('Serenitea Las Pinas'), 'serenitea');
});

test('normalizes punctuation and case consistently', () => {
  assert.equal(
    normalizeName("Dolora's Hauz of Pancit Malabon"),
    'doloras hauz of pancit malabon',
  );
  assert.equal(normalizeName('Mann Hann'), 'mann hann');
  assert.equal(normalizeName("Gerry's Grill"), 'gerrys grill');
});

test('never strips a name down to nothing', () => {
  // "The Manila" is all strippable tokens; must fall back, not vanish.
  const out = normalizeName('The Manila');
  assert.ok(out.length >= 3, `stripped to "${out}"`);
  assert.equal(normalizeName('SM'), 'sm');
});

test('generic names are not countable as chains', () => {
  for (const g of ['cafe', 'bakery', 'restaurant', 'carinderia', 'sari sari store']) {
    assert.equal(isCountableName(g), false, `"${g}" should not be countable`);
  }
  assert.equal(isCountableName('ab'), false);
  assert.equal(isCountableName('jollibee'), true);
  assert.equal(isCountableName('doloras hauz of pancit malabon'), true);
});

test('basicClean strips accents and separators', () => {
  assert.equal(basicClean('Café  Niño—Two'), 'cafe nino two');
});
