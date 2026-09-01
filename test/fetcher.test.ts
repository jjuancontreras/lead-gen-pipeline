import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameSimilarity } from '../src/fetcher.ts';

test('identical and near-identical names score high', () => {
  assert.equal(nameSimilarity('Kohi', 'Kohi'), 1);
  assert.ok(nameSimilarity('Kohi - Maginhawa', 'Kohi Maginhawa') >= 0.9);
  assert.ok(nameSimilarity("Gerry's Grill", 'Gerrys Grill') >= 0.9);
});

test('different businesses score low', () => {
  assert.ok(nameSimilarity('Kohi', 'Starbucks') < 0.3);
  assert.ok(nameSimilarity('The Porch', 'Vikings Luxury Buffet') < 0.3);
});

test('short tokens are ignored so they cannot carry a false match', () => {
  // "of" and "by" must not make unrelated names look similar.
  assert.ok(nameSimilarity('House of Lasagna', 'House of Pancakes') < 1);
});

test('hyphenation and spacing differences still match', () => {
  // Real miss from a live run: these are the same business, but token
  // overlap alone scored 0.00 and sent it to manual review.
  assert.ok(nameSimilarity('Danny-Licious', 'Dannylicious BBQ - A. Luna') >= 0.6,
    'hyphenated vs concatenated form should match');
  assert.ok(nameSimilarity('KopiRoti', 'Kopi Roti') >= 0.6);
});

test('the concatenated path does not create false matches', () => {
  assert.ok(nameSimilarity('Kohi', 'Kohinoor Palace Restaurant') < 0.6,
    'a short name must not match a much longer one on prefix alone');
  assert.ok(nameSimilarity('Indulge', 'Starbucks Reserve') < 0.3);
});

test('empty input never matches', () => {
  assert.equal(nameSimilarity('', 'Kohi'), 0);
  assert.equal(nameSimilarity('Kohi', ''), 0);
});
