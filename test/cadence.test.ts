import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, daysBetween, followUpTemplateFor, nextActionAfter, FINAL_TEMPLATE,
} from '../src/cadence.ts';

test('addDays crosses month boundaries in UTC', () => {
  assert.equal(addDays('2026-08-30', 3), '2026-09-02');
  assert.equal(addDays('2026-09-02', 0), '2026-09-02');
});

test('daysBetween counts whole days, and never returns NaN', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-08'), 7);
  assert.equal(daysBetween('2026-09-08', '2026-09-01'), -7);
  assert.equal(daysBetween('', '2026-09-01'), 0, 'a blank start is day zero, not NaN');
  assert.equal(daysBetween('not-a-date', '2026-09-01'), 0);
});

test('the due step is derived from days since first contact', () => {
  const first = '2026-09-01';
  assert.equal(followUpTemplateFor(first, '2026-09-04'), 'follow-up-3');
  assert.equal(followUpTemplateFor(first, '2026-09-06'), 'follow-up-3');
  assert.equal(followUpTemplateFor(first, '2026-09-08'), 'follow-up-7');
  assert.equal(followUpTemplateFor(first, '2026-09-15'), 'breakup-14');
  assert.equal(followUpTemplateFor(first, '2026-10-30'), 'breakup-14', 'the last step is terminal');
});

test('a lead with no recorded first contact lands on the gentlest step', () => {
  assert.equal(followUpTemplateFor('', '2026-09-15'), 'follow-up-3');
});

test('the next action date is the next unpassed rung of the cadence', () => {
  const first = '2026-09-01';
  assert.equal(nextActionAfter(first, first), '2026-09-04', 'first contact schedules day 3');
  assert.equal(nextActionAfter(first, '2026-09-04'), '2026-09-08');
  assert.equal(nextActionAfter(first, '2026-09-08'), '2026-09-15');
});

test('CRITICAL: the sequence ends after the breakup instead of looping', () => {
  const first = '2026-09-01';
  assert.equal(nextActionAfter(first, '2026-09-15'), '', 'a sent breakup schedules nothing');
  assert.equal(nextActionAfter(first, '2026-12-01'), '');
  assert.equal(FINAL_TEMPLATE, 'breakup-14');
});

test('a first contact with no earlier timestamp starts the clock today', () => {
  assert.equal(nextActionAfter('', '2026-09-02'), '2026-09-05');
});
