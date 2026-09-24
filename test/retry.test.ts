import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, withTimeout, TimeoutError, computeBackoffMs } from '../src/retry.ts';

const noSleep = async () => {};

test('returns the first success without retrying', async () => {
  let calls = 0;
  const out = await withRetry(async () => { calls++; return 'ok'; }, { sleep: noSleep });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('retries a failing call and returns the eventual success', async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('flaky');
    return calls;
  }, { attempts: 3, sleep: noSleep });
  assert.equal(out, 3);
});

test('gives up after the attempt budget and rethrows the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error(`fail ${calls}`); }, { attempts: 2, sleep: noSleep }),
    /fail 2/,
  );
  assert.equal(calls, 2);
});

test('a non-retryable error fails immediately', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('bad request'); }, {
      attempts: 5, sleep: noSleep, isRetryable: (e) => !/bad request/.test((e as Error).message),
    }),
    /bad request/,
  );
  assert.equal(calls, 1);
});

test('backs off exponentially between attempts', async () => {
  const waits: number[] = [];
  await assert.rejects(withRetry(async () => { throw new Error('x'); }, {
    attempts: 4, baseMs: 100, maxMs: 10_000, random: () => 1,
    sleep: async (ms) => { waits.push(ms); },
  }));
  assert.deepEqual(waits, [100, 200, 400]);
});

test('reports each retry to onRetry', async () => {
  const seen: number[] = [];
  await assert.rejects(withRetry(async () => { throw new Error('x'); }, {
    attempts: 3, sleep: noSleep, onRetry: (_e, attempt) => seen.push(attempt),
  }));
  assert.deepEqual(seen, [1, 2]);
});

test('an attempt that exceeds its timeout fails with TimeoutError and is retried', async () => {
  let calls = 0;
  const out = await withRetry(async (_attempt, signal) => {
    calls++;
    if (calls === 1) {
      await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    }
    return 'second try';
  }, { attempts: 2, timeoutMs: 20, sleep: noSleep });
  assert.equal(out, 'second try');
  assert.equal(calls, 2);
});

test('withTimeout rejects a hung promise and aborts its signal', async () => {
  let aborted = false;
  await assert.rejects(
    withTimeout((signal) => new Promise(() => {
      signal.addEventListener('abort', () => { aborted = true; });
    }), 15, 'hung call'),
    (err) => err instanceof TimeoutError && /hung call/.test(err.message),
  );
  assert.equal(aborted, true);
});

test('withTimeout passes a fast result through', async () => {
  assert.equal(await withTimeout(async () => 7, 1000, 'fast'), 7);
});

test('computeBackoffMs is capped and uses full jitter', () => {
  assert.equal(computeBackoffMs(10, { baseMs: 1000, maxMs: 5000, rand: () => 1 }), 5000);
  assert.equal(computeBackoffMs(2, { baseMs: 1000, maxMs: 20_000, rand: () => 0.5 }), 2000);
  assert.equal(computeBackoffMs(3, { rand: () => 0 }), 0);
});
