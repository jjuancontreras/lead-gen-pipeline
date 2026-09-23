import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, isCountableName, basicClean, slugify } from '../src/normalize.ts';

test('slugify: lowercase kebab, accents folded, apostrophes closed up, 40 chars max', () => {
  assert.equal(slugify("Fred's Revolucion"), 'freds-revolucion');
  assert.equal(slugify('Café Niño & Co.'), 'cafe-nino-co');
  assert.equal(slugify('  --Tiny Tavern--  '), 'tiny-tavern');
  assert.equal(slugify('a'.repeat(60)).length, 40);
  assert.equal(slugify('!!!'), 'demo', 'a name with no usable characters still gets a slug');
});

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
  for (const g of ['cafe', 'bakery', 'restaurant', 'carinderia', 'sari sari']) {
    assert.equal(isCountableName(g), false, `"${g}" should not be countable`);
  }
  assert.equal(isCountableName('ab'), false);
  assert.equal(isCountableName('jollibee'), true);
  assert.equal(isCountableName('doloras hauz of pancit malabon'), true);
});

test('normalizeName("Sari-Sari Store") produces the key GENERIC_NAMES actually holds', () => {
  // Regression for a dead denylist-style entry: "store" is a BRANCH_TOKEN
  // and is stripped before GENERIC_NAMES is ever consulted, so an entry of
  // "sari sari store" could never match. The set must hold "sari sari".
  assert.equal(normalizeName('Sari-Sari Store'), 'sari sari');
  assert.equal(isCountableName(normalizeName('Sari-Sari Store')), false);
});

test('generic trade names stay uncountable even at phase-2 chain volume', () => {
  // 21 "Dental Clinic"s, 20 "Barber Shop"/"Barbershop"s and 6 "Sari-Sari
  // Store"s share a name in the real corpus without being related - phase 2
  // must not merge them into a fake chain and reject them all.
  for (const name of ['Dental Clinic', 'DENTAL CLINIC', 'Barber Shop', 'The Barber Shop', 'Barbershop', 'Sari-Sari Store']) {
    assert.equal(isCountableName(normalizeName(name)), false, `"${name}" should not be countable`);
  }
});

test('REGRESSION: PROTECTED_BIGRAMS saves the first word too, not just the second (QA MEDIUM #9)', () => {
  // The bigram was only ever checked against the PRECEDING word, so it
  // could rescue the second word of the pair but not the first - when the
  // first word was itself a location token, it was stripped before the
  // bigram check for the second word ever ran.
  assert.equal(normalizeName('Kusina Manila Bay'), 'kusina manila bay');
  assert.equal(normalizeName('The Roadhouse Manila Bay'), 'roadhouse manila bay');
  assert.equal(normalizeName('Kusina Quezon City'), 'kusina quezon city');
  assert.equal(normalizeName('Aesthetic Science Quezon City'), 'aesthetic science quezon city');
  assert.equal(normalizeName('Kusina Binondo Style'), 'kusina binondo style');
});

test('basicClean strips accents and separators', () => {
  assert.equal(basicClean('Café  Niño—Two'), 'cafe nino two');
});
