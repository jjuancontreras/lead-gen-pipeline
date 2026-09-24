import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intFlag, optionalIntFlag, multiFlag, val } from '../src/cli-args.ts';

test('val reads the value after a flag', () => {
  assert.equal(val('--area', ['--area', 'katipunan']), 'katipunan');
  assert.equal(val('--area', ['--dry-run']), undefined);
});

test('intFlag uses the default only when the flag is absent', () => {
  assert.equal(intFlag('--limit', 20, []), 20);
  assert.equal(intFlag('--limit', 20, ['--limit', '5']), 5);
});

test('REGRESSION: a non-numeric cap is an error, not a silent zero', () => {
  assert.throws(() => intFlag('--max-verify', 40, ['--max-verify', 'abc']), /--max-verify.*"abc"/);
  assert.throws(() => intFlag('--limit', 20, ['--limit', '0']), /positive/);
  assert.throws(() => intFlag('--limit', 20, ['--limit', '-3']), /positive/);
  assert.throws(() => intFlag('--limit', 20, ['--limit', '2.5']), /whole/);
  assert.throws(() => intFlag('--limit', 20, ['--limit']), /"undefined"|positive/);
});

test('optionalIntFlag is undefined when absent', () => {
  assert.equal(optionalIntFlag('--target-ms', []), undefined);
  assert.equal(optionalIntFlag('--target-ms', ['--target-ms', '9000']), 9000);
});

test('multiFlag collects every value of a repeated flag', () => {
  assert.deepEqual(multiFlag('--lead', ['--lead', 'a', '--x', '--lead', 'b']), ['a', 'b']);
  assert.deepEqual(multiFlag('--lead', ['--lead']), []);
});
