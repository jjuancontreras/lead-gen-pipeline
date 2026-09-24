import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PipelineState } from '../src/pipeline/state.ts';

const fresh = () => new PipelineState(join(mkdtempSync(join(tmpdir(), 'pl-state-')), 'state.json'));

test('an untouched stage reads as pending with no attempts', () => {
  const s = fresh();
  assert.deepEqual(s.entry('node/1', 'site'), { status: 'pending', attempts: 0 });
  assert.equal(existsSync(s.path), false, 'reading writes nothing');
});

test('update persists and merges, leaving other stages and leads alone', () => {
  const s = fresh();
  s.update('node/1', 'find', { status: 'done', attempts: 1 });
  s.update('node/1', 'site', { status: 'failed', attempts: 1, error: 'boom' });
  s.update('node/2', 'find', { status: 'running', attempts: 1 });
  s.update('node/1', 'site', { status: 'done', error: undefined });

  const again = new PipelineState(s.path);
  assert.equal(again.entry('node/1', 'find').status, 'done');
  assert.equal(again.entry('node/1', 'site').status, 'done');
  assert.equal(again.entry('node/1', 'site').attempts, 1);
  assert.equal(again.entry('node/2', 'find').status, 'running');
  assert.deepEqual(again.leadIds().sort(), ['node/1', 'node/2']);
});

test('reset makes the stage and every later one pending, keeping attempts', () => {
  const s = fresh();
  for (const stage of ['find', 'site', 'video', 'email'] as const) {
    s.update('node/1', stage, { status: 'done', attempts: 2, output: { x: 1 } });
  }
  s.reset('node/1', 'video');
  assert.equal(s.entry('node/1', 'find').status, 'done');
  assert.equal(s.entry('node/1', 'site').status, 'done');
  assert.deepEqual(s.entry('node/1', 'video'), { status: 'pending', attempts: 2 });
  assert.deepEqual(s.entry('node/1', 'email'), { status: 'pending', attempts: 2 });
});

test('a corrupt state file is an error that names the file, not a silent reset', () => {
  const s = fresh();
  writeFileSync(s.path, JSON.stringify({ version: 1, leads: { 'node/1': { find: { status: 'exploded', attempts: 0 } } } }));
  assert.throws(() => s.read(), /not a valid pipeline state file/);
});
