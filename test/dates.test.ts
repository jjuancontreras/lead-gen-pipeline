import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDate, addDays, daysBetween } from '../src/dates.ts';

test('REGRESSION: 07:30 in Manila is already the next day there, not yesterday in UTC', () => {
  // 2026-09-22T23:30Z is 2026-09-23 07:30 in Asia/Manila (UTC+8).
  assert.equal(localDate(new Date('2026-09-22T23:30:00Z')), '2026-09-23');
});

test('the Manila day ends at 16:00 UTC', () => {
  assert.equal(localDate(new Date('2026-09-23T15:59:59Z')), '2026-09-23');
  assert.equal(localDate(new Date('2026-09-23T16:00:00Z')), '2026-09-24');
});

test('addDays crosses month boundaries', () => {
  assert.equal(addDays('2026-08-30', 3), '2026-09-02');
  assert.equal(addDays('2026-09-02', 0), '2026-09-02');
});

test('daysBetween counts whole days, and never returns NaN', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-08'), 7);
  assert.equal(daysBetween('2026-09-08', '2026-09-01'), -7);
  assert.equal(daysBetween('', '2026-09-01'), 0, 'a blank start is day zero, not NaN');
  assert.equal(daysBetween('not-a-date', '2026-09-01'), 0);
});
