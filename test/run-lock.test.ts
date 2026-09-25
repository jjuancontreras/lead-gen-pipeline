import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireRunLock, RunLockHeld } from '../src/run-lock.ts';

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'pl-lock-')), 'pipeline.lock');

test('acquiring writes our pid; releasing removes the file', () => {
  const path = lockPath();
  const lock = acquireRunLock(path, { pid: 4242, isAlive: () => true });
  assert.equal(readFileSync(path, 'utf8'), '4242');
  lock.release();
  assert.equal(existsSync(path), false);
});

test('REGRESSION: a second run is refused while the first is alive', () => {
  const path = lockPath();
  const first = acquireRunLock(path, { pid: 1111, isAlive: () => true });
  assert.throws(() => acquireRunLock(path, { pid: 2222, isAlive: () => true }),
    (err) => err instanceof RunLockHeld && /pid 1111/.test(err.message));
  first.release();
  assert.doesNotThrow(() => acquireRunLock(path, { pid: 2222, isAlive: () => true }).release());
});

test('a lock left by a crashed run is taken over', () => {
  const path = lockPath();
  writeFileSync(path, '9999');
  const lock = acquireRunLock(path, { pid: 3333, isAlive: (pid) => pid !== 9999 });
  assert.equal(readFileSync(path, 'utf8'), '3333');
  lock.release();
});

test('a garbled lock file counts as stale', () => {
  const path = lockPath();
  writeFileSync(path, 'not a pid');
  assert.doesNotThrow(() => acquireRunLock(path, { pid: 5, isAlive: () => true }).release());
});

test('release only removes a lock this run still owns', () => {
  const path = lockPath();
  const lock = acquireRunLock(path, { pid: 7, isAlive: () => true });
  writeFileSync(path, '8'); // taken over after we were presumed dead
  lock.release();
  assert.equal(readFileSync(path, 'utf8'), '8');
});
