import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocatePort, readLaunchConfig, withLaunchLock, mapQueryFor, formatPhoneDisplay,
} from '../src/scaffold.ts';

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-test-'));
  return join(dir, name);
}

test('allocatePort gives distinct ports for distinct slugs, starting at 3011', () => {
  const r1 = allocatePort([], 'demo-alpha');
  assert.equal(r1.port, 3011);
  assert.equal(r1.isNew, true);

  const r2 = allocatePort(r1.configurations, 'demo-beta');
  assert.equal(r2.port, 3012);
  assert.notEqual(r2.port, r1.port);
  // Both entries survive when the second allocation is built on the
  // first's output (the sequential, correct usage).
  assert.equal(r2.configurations.length, 2);
  assert.ok(r2.configurations.some((c) => c.name === 'demo-alpha'));
  assert.ok(r2.configurations.some((c) => c.name === 'demo-beta'));
});

test('reallocating the same slug returns its existing port and does not duplicate it', () => {
  const r1 = allocatePort([], 'demo-alpha');
  const r2 = allocatePort(r1.configurations, 'demo-alpha');
  assert.equal(r2.port, r1.port);
  assert.equal(r2.isNew, false);
  assert.equal(r2.configurations.length, 1);
});

test('REGRESSION: two sessions reading the same stale snapshot collide and lose an entry', () => {
  // This reproduces the exact failure from the QA report: session A and
  // session B both read the configurations array BEFORE either writes
  // (the bug - allocatePort itself is pure and has no lock; the fix is
  // that scaffoldDemo now only ever calls it once per withLaunchLock
  // critical section). Demonstrating the collision here is what proves
  // the lock in scaffoldDemo is load-bearing, not decorative.
  const stale = allocatePort([], 'existing-project').configurations;
  const a = allocatePort(stale, 'demo-alpha');
  const b = allocatePort(stale, 'demo-beta');
  assert.equal(a.port, b.port, 'both sessions computed the same port from the stale snapshot');
  // If B's result (built on the same stale snapshot) is what gets written
  // last, "demo-alpha" is gone - exactly what the report observed.
  assert.equal(b.configurations.some((c) => c.name === 'demo-alpha'), false);
});

test('a taken port stored as a string still blocks reallocating it', () => {
  const configurations = [
    { name: 'legacy', runtimeExecutable: 'npm', runtimeArgs: [], port: '3011' as unknown as number },
  ];
  const r = allocatePort(configurations, 'demo-alpha');
  assert.notEqual(r.port, 3011, 'string port "3011" was not recognised as taken');
  assert.equal(r.port, 3012);
});

test('readLaunchConfig throws on malformed JSON, before any scaffold file would be touched', () => {
  const path = tmpFile('launch.json');
  writeFileSync(path, '{"configurations":[');
  assert.throws(() => readLaunchConfig(path), /not valid JSON/);
});

test('readLaunchConfig throws when "configurations" is missing or not an array', () => {
  const p1 = tmpFile('launch.json');
  writeFileSync(p1, JSON.stringify({ version: '0.0.1' }));
  assert.throws(() => readLaunchConfig(p1), /configurations/);

  const p2 = tmpFile('launch.json');
  writeFileSync(p2, JSON.stringify({ configurations: null }));
  assert.throws(() => readLaunchConfig(p2), /configurations/);
});

test('readLaunchConfig accepts a well-formed file', () => {
  const path = tmpFile('launch.json');
  writeFileSync(path, JSON.stringify({ version: '0.0.1', configurations: [] }));
  const cfg = readLaunchConfig(path);
  assert.deepEqual(cfg.configurations, []);
});

test('readLaunchConfig returns an empty config when the file does not exist, rather than throwing', () => {
  // A fresh checkout has no launch.json yet - that's the normal first-run
  // state, not a corrupt file. tmpFile() only creates the parent dir, not
  // the file itself, so this path is guaranteed missing.
  const path = tmpFile('launch.json');
  const cfg = readLaunchConfig(path);
  assert.deepEqual(cfg, { version: '0.0.1', configurations: [] });
});

test('the config returned for a missing launch.json is directly usable by allocatePort', () => {
  const path = tmpFile('launch.json');
  const cfg = readLaunchConfig(path);
  const r = allocatePort(cfg.configurations, 'demo-alpha');
  assert.equal(r.port, 3011);
  assert.equal(r.isNew, true);
});

test('withLaunchLock: the lock file is created and removed around fn', () => {
  const lockPath = tmpFile('launch.json.lock');
  let sawLockDuringRun = false;
  withLaunchLock(() => {
    sawLockDuringRun = existsSync(lockPath);
  }, { lockPath });
  assert.equal(sawLockDuringRun, true, 'lock file should exist while fn runs');
  assert.equal(existsSync(lockPath), false, 'lock file should be removed after fn returns');
});

test('withLaunchLock: an already-held lock blocks a second caller until it times out', () => {
  const lockPath = tmpFile('launch.json.lock');
  writeFileSync(lockPath, 'held-by-another-session', { flag: 'wx' });
  try {
    assert.throws(
      () => withLaunchLock(() => 'should not run', { lockPath, timeoutMs: 150, retryMs: 20 }),
      /Timed out waiting for/,
    );
  } finally {
    rmSync(lockPath, { force: true });
  }
});

test('withLaunchLock releases the lock even if fn throws', () => {
  const lockPath = tmpFile('launch.json.lock');
  assert.throws(() => withLaunchLock(() => { throw new Error('boom'); }, { lockPath }), /boom/);
  assert.equal(existsSync(lockPath), false, 'lock must not be left behind after a throw');
});

test('mapQueryFor appends the area label when one resolves', () => {
  assert.equal(mapQueryFor('Gubat', 'Katipunan, Quezon City'), 'Gubat, Katipunan, Quezon City');
});

test('mapQueryFor falls back to the bare name when there is no area label', () => {
  assert.equal(mapQueryFor('Gubat', undefined), 'Gubat');
});

test('formatPhoneDisplay formats an 09-prefixed mobile number in 4-3-4 groups', () => {
  assert.equal(formatPhoneDisplay('09171234567'), '0917 123 4567');
});

test('formatPhoneDisplay normalises a +63 mobile number before formatting', () => {
  assert.equal(formatPhoneDisplay('+639171234567'), '0917 123 4567');
});

test('formatPhoneDisplay normalises a bare 63-prefixed mobile number before formatting', () => {
  assert.equal(formatPhoneDisplay('639171234567'), '0917 123 4567');
});

test('formatPhoneDisplay formats a Metro Manila landline as (02) NNNN NNNN', () => {
  assert.equal(formatPhoneDisplay('0288881234'), '(02) 8888 1234');
});

test('formatPhoneDisplay normalises a +63 landline number before formatting', () => {
  assert.equal(formatPhoneDisplay('+63288881234'), '(02) 8888 1234');
});

test('formatPhoneDisplay strips spaces, dashes and parentheses before classifying', () => {
  assert.equal(formatPhoneDisplay('0917-123 4567'), '0917 123 4567');
  assert.equal(formatPhoneDisplay('(02) 8888-1234'), '(02) 8888 1234');
});

test('formatPhoneDisplay returns an empty string unchanged', () => {
  assert.equal(formatPhoneDisplay(''), '');
});

test('formatPhoneDisplay returns an unrecognised shape unchanged rather than mangling it', () => {
  assert.equal(formatPhoneDisplay('12345'), '12345');
  assert.equal(formatPhoneDisplay('not-a-phone'), 'not-a-phone');
});
