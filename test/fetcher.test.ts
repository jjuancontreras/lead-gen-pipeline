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

test('empty input never matches', () => {
  assert.equal(nameSimilarity('', 'Kohi'), 0);
  assert.equal(nameSimilarity('Kohi', ''), 0);
});
