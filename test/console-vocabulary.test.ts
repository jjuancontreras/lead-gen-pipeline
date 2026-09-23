import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error - plain browser ES module, no type declarations
import { STATUSES as CONSOLE_STATUSES, VIEWS } from '../console/js/vocabulary.js';
import { STATUSES, INACTIVE } from '../src/lead.ts';

type ConsoleStatus = { key: string };
type ConsoleView = { key: string; statuses: string[] | null };

test('the console knows every pipeline status, in pipeline order', () => {
  // Order drives the console's "pipeline stage" sort, so it must match too.
  assert.deepEqual((CONSOLE_STATUSES as ConsoleStatus[]).map((s) => s.key), [...STATUSES]);
});

test('every console view filters on real statuses, and "Closed" is exactly INACTIVE', () => {
  const known = new Set<string>(STATUSES);
  for (const v of VIEWS as ConsoleView[]) {
    for (const s of v.statuses ?? []) assert.ok(known.has(s), `view "${v.key}" filters on unknown status "${s}"`);
  }
  const closed = (VIEWS as ConsoleView[]).find((v) => v.key === 'closed')!;
  assert.deepEqual(new Set(closed.statuses), new Set(INACTIVE));
});
