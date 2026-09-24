import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameSimilarity, parseReviewCount } from '../src/fetcher.ts';

test('review count comes from the parenthesised header count first', () => {
  assert.equal(parseReviewCount('Kohi\n4.6\n(1,234)\nCafe'), '1234');
});

test('REGRESSION: the "N reviews" fallback matches when the header has no count', () => {
  // The fallback regex once held a literal backspace where \b was meant, so
  // it could never match and every slow-settling panel lost its count.
  const panel = `Kohi\n4.6\nCafe\n${'Menu and more. '.repeat(60)}\n23 reviews\nWrite a review`;
  assert.equal(parseReviewCount(panel), '23');
  assert.equal(parseReviewCount(`${'x'.repeat(700)}\n1 review\n`), '1');
});

test('no count anywhere is null, and "reviewsx" is not a count', () => {
  assert.equal(parseReviewCount('Kohi\nCafe'), null);
  assert.equal(parseReviewCount(`${'x'.repeat(700)} 5 reviewsx`), null);
});

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
