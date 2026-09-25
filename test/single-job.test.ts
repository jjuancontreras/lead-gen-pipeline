import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SingleJob } from '../src/single-job.ts';
import { errorMessage } from '../src/errors.ts';
import { z } from 'zod';

const settle = () => new Promise((r) => setImmediate(r));

test('SingleJob refuses a second job while one runs', async () => {
  const job = new SingleJob();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  assert.equal(job.start('first', () => gate), true);
  assert.equal(job.start('second', async () => {}), false);
  assert.equal(job.status().label, 'first');
  release();
  await gate;
  await settle();
  assert.equal(job.status().running, false);
});

test('SingleJob keeps the last result or error until the next job starts', async () => {
  const job = new SingleJob();
  job.start('ok', async () => 'recorded 2 takes');
  await settle();
  assert.deepEqual(job.status(), { running: false, lastResult: 'recorded 2 takes' });
  job.start('boom', async () => { throw new Error('nope'); });
  await settle();
  assert.deepEqual(job.status(), { running: false, lastError: 'nope' });
});

test('errorMessage flattens zod issues into one readable line', () => {
  const r = z.object({ url: z.url() }).safeParse({ url: 'x' });
  assert.ok(!r.success);
  assert.match(errorMessage(r.error), /^url: /);
  assert.equal(errorMessage(new Error('plain')), 'plain');
  assert.equal(errorMessage('str'), 'str');
});
