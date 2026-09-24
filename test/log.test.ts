import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/log.ts';

function capture(format: 'json' | 'pretty', level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  const lines: string[] = [];
  const log = createLogger({
    format, level, sink: (l) => lines.push(l), clock: () => new Date('2026-09-25T01:02:03Z'),
  });
  return { log, lines };
}

test('json lines carry level, message, time and fields', () => {
  const { log, lines } = capture('json');
  log.info('site written', { lead: 'node/1', bytes: 42 });
  assert.deepEqual(JSON.parse(lines[0]!), {
    ts: '2026-09-25T01:02:03.000Z', level: 'info', msg: 'site written', lead: 'node/1', bytes: 42,
  });
});

test('child loggers add their fields to every line', () => {
  const { log, lines } = capture('json');
  log.child({ stage: 'video' }).child({ lead: 'node/2' }).warn('slow');
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.stage, 'video');
  assert.equal(rec.lead, 'node/2');
  assert.equal(rec.level, 'warn');
});

test('lines below the level are dropped', () => {
  const { log, lines } = capture('json', 'warn');
  log.debug('a');
  log.info('b');
  log.warn('c');
  log.error('d');
  assert.deepEqual(lines.map((l) => JSON.parse(l).msg), ['c', 'd']);
});

test('pretty format is one readable line with stage and lead up front', () => {
  const { log, lines } = capture('pretty');
  log.child({ stage: 'email', lead: 'node/3' }).error('no address', { tries: 2 });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /error/);
  assert.match(lines[0]!, /\[email\]/);
  assert.match(lines[0]!, /node\/3/);
  assert.match(lines[0]!, /no address/);
  assert.match(lines[0]!, /tries=2/);
});

test('an Error field is logged as its message, not {}', () => {
  const { log, lines } = capture('json');
  log.error('failed', { err: new Error('boom') });
  assert.equal(JSON.parse(lines[0]!).err, 'boom');
});
