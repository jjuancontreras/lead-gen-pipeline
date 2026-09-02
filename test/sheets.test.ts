import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  columnLetter, a1Range, fullRange, LAST_COLUMN, HEADER_ROW,
  headerMismatch, assertHeader, sheetToLeads, appendPlan, updatePlan,
  parseServiceAccount, DEFAULT_TAB,
} from '../src/store-sheets.ts';
import { COLUMNS, emptyLead, toRow, type Lead } from '../src/lead.ts';

// These tests never touch the network. Everything exercised here is the pure
// half of the store - the half that can be wrong silently.

function lead(id: string, over: Partial<Lead> = {}): Lead {
  return { ...emptyLead(), lead_id: id, name: id, ...over };
}

// ---- A1 ranges --------------------------------------------------------------

test('column letters are bijective base-26, not base-26 with a zero', () => {
  assert.equal(columnLetter(1), 'A');
  assert.equal(columnLetter(26), 'Z');
  assert.equal(columnLetter(27), 'AA');
  assert.equal(columnLetter(52), 'AZ');
  assert.equal(columnLetter(53), 'BA');
  assert.equal(columnLetter(702), 'ZZ');
  assert.equal(columnLetter(703), 'AAA');
});

test('column index must be a positive integer', () => {
  assert.throws(() => columnLetter(0), /positive integer/);
  assert.throws(() => columnLetter(-1), /positive integer/);
  assert.throws(() => columnLetter(1.5), /positive integer/);
});

test('the last column covers exactly the lead schema', () => {
  assert.equal(LAST_COLUMN, columnLetter(COLUMNS.length));
  // A guard against someone appending a column and not noticing the range.
  assert.equal(LAST_COLUMN, 'AN');
  assert.equal(COLUMNS.length, 40);
});

test('a1Range spans A to the last schema column', () => {
  assert.equal(a1Range('Leads', 2, 5), `Leads!A2:${LAST_COLUMN}5`);
  assert.equal(a1Range('Leads', 7, 7), `Leads!A7:${LAST_COLUMN}7`);
  assert.equal(fullRange('Leads'), `Leads!A1:${LAST_COLUMN}`);
});

test('tab names that need quoting get quoted', () => {
  assert.equal(a1Range('My Leads', 2, 2), `'My Leads'!A2:${LAST_COLUMN}2`);
  assert.equal(a1Range("Ann's", 2, 2), `'Ann''s'!A2:${LAST_COLUMN}2`);
  assert.equal(fullRange('My Leads'), `'My Leads'!A1:${LAST_COLUMN}`);
  // The default needs none, so the common range stays readable in logs.
  assert.equal(a1Range(DEFAULT_TAB, 2, 2), `Leads!A2:${LAST_COLUMN}2`);
});

// ---- header validation: the expensive-to-get-wrong part ---------------------

test('the exact schema header passes', () => {
  assert.equal(headerMismatch(HEADER_ROW), null);
  assert.equal(headerMismatch([...COLUMNS] as string[]), null);
  assert.doesNotThrow(() => assertHeader(HEADER_ROW, 'sheet'));
});

test('trailing blank cells are Sheets padding, not extra columns', () => {
  assert.equal(headerMismatch([...HEADER_ROW, '', '', '']), null);
});

test('CRITICAL: a shifted column is named, not tolerated', () => {
  // Somebody inserted a column before `email`; every contact from here on is
  // one cell to the right of where the code thinks it is.
  const shifted = [...HEADER_ROW];
  shifted.splice(17, 0, 'notes_old');
  const problem = headerMismatch(shifted);
  assert.ok(problem, 'a shifted header must not pass');
  assert.match(problem, /column R/, 'the offending cell should be named');
  assert.match(problem, /notes_old/);
  assert.match(problem, /email/);
});

test('CRITICAL: swapped columns are caught', () => {
  const swapped = [...HEADER_ROW];
  const i = COLUMNS.indexOf('email');
  const j = COLUMNS.indexOf('phone');
  [swapped[i], swapped[j]] = [swapped[j]!, swapped[i]!];
  assert.match(headerMismatch(swapped) ?? '', /column R is "phone"/);
});

test('a truncated header is reported as a missing column', () => {
  const problem = headerMismatch(HEADER_ROW.slice(0, 10));
  assert.match(problem ?? '', /column K is missing/);
  assert.match(problem ?? '', /cuisine/);
});

test('extra columns past the schema are reported', () => {
  const problem = headerMismatch([...HEADER_ROW, 'my_notes']);
  assert.match(problem ?? '', /unexpected column/);
  assert.match(problem ?? '', /my_notes/);
});

test('an empty header row is a mismatch, not an empty sheet', () => {
  assert.match(headerMismatch([]) ?? '', /column A is missing/);
});

test('assertHeader throws with the sheet location and the fix', () => {
  assert.throws(
    () => assertHeader(['nope'], 'https://docs.google.com/x (Leads)'),
    (err: Error) => {
      assert.match(err.message, /docs\.google\.com/);
      assert.match(err.message, /column A is "nope"/);
      assert.match(err.message, /COLUMNS/);
      return true;
    },
  );
});

// ---- row mapping ------------------------------------------------------------

test('sheetToLeads skips the header and maps by position', () => {
  const a = lead('node/1', { email: 'hi@kurocafe.ph', status: 'verified' });
  const leads = sheetToLeads([HEADER_ROW, toRow(a)]);
  assert.equal(leads.length, 1);
  assert.equal(leads[0]!.lead_id, 'node/1');
  assert.equal(leads[0]!.email, 'hi@kurocafe.ph');
  assert.equal(leads[0]!.status, 'verified');
});

test('ragged rows survive - Sheets truncates trailing empty cells', () => {
  // A real response: only the first three cells were ever written.
  const leads = sheetToLeads([HEADER_ROW, ['node/9', 'Kuro Cafe', 'amenity=cafe']]);
  assert.equal(leads.length, 1);
  assert.equal(leads[0]!.name, 'Kuro Cafe');
  assert.equal(leads[0]!.do_not_contact, '', 'missing cells read as empty, not undefined');
  assert.equal(leads[0]!.notes, '');
});

test('spacer rows a person left behind are not leads', () => {
  const leads = sheetToLeads([HEADER_ROW, [], ['', '', ''], toRow(lead('node/2'))]);
  assert.deepEqual(leads.map((l) => l.lead_id), ['node/2']);
});

test('an empty sheet body yields no leads', () => {
  assert.deepEqual(sheetToLeads([HEADER_ROW]), []);
});

// ---- upsert: insert-only, exactly like the JSON store -----------------------

test('appendPlan only adds ids the sheet does not have', () => {
  const existing = [lead('node/1'), lead('node/2')];
  const plan = appendPlan(existing, [lead('node/2'), lead('node/3')], 3);
  assert.equal(plan.added, 1);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0]![0], 'node/3');
});

test('CRITICAL: upsert never overwrites - a known id is skipped whole', () => {
  const existing = [lead('node/1', { email: 'typed@byhand.ph', notes: 'called them' })];
  // The scraper has no idea about the hand-typed email.
  const plan = appendPlan(existing, [lead('node/1')], 2);
  assert.equal(plan.added, 0);
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.rows, [], 'nothing is written, so nothing can be flattened');
});

test('duplicates inside one batch are deduped too', () => {
  // The sheet cannot catch these: neither row is there yet.
  const plan = appendPlan([], [lead('node/5'), lead('node/5'), lead('node/6')], 1);
  assert.equal(plan.added, 2);
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.rows.map((r) => r[0]), ['node/5', 'node/6']);
});

test('new rows land after the last row, header included in the count', () => {
  // Header only -> first data row is 2.
  assert.equal(appendPlan([], [lead('node/1')], 1).firstRow, 2);
  // Header + 4 leads -> next free row is 6.
  assert.equal(appendPlan([], [lead('node/1')], 5).firstRow, 6);
  // A sheet reported as completely empty still starts at 2, never at 1:
  // row 1 belongs to the header.
  assert.equal(appendPlan([], [lead('node/1')], 0).firstRow, 2);
});

test('every appended row is full width, so no column can shift', () => {
  const plan = appendPlan([], [lead('node/1'), lead('node/2')], 1);
  for (const row of plan.rows) assert.equal(row.length, COLUMNS.length);
});

test('nothing new means no write at all', () => {
  const plan = appendPlan([lead('node/1')], [lead('node/1')], 2);
  assert.equal(plan.rows.length, 0);
});

// ---- update -----------------------------------------------------------------

test('updatePlan targets the lead-s own row and merges the patch', () => {
  const values = [HEADER_ROW, toRow(lead('node/1')), toRow(lead('node/2', { phone: '+639170000000' }))];
  const plan = updatePlan(values, 'node/2', { email: 'hi@kurocafe.ph', status: 'verified' });
  assert.equal(plan.row, 3);
  assert.equal(plan.values.length, COLUMNS.length);
  assert.equal(plan.values[COLUMNS.indexOf('email')], 'hi@kurocafe.ph');
  assert.equal(plan.values[COLUMNS.indexOf('status')], 'verified');
  assert.equal(plan.values[COLUMNS.indexOf('phone')], '+639170000000', 'untouched fields survive');
});

test('CRITICAL: a spacer row does not shift the update target', () => {
  // sheetToLeads drops the blank row, so a leads-array index would point one
  // row too high and overwrite the wrong business.
  const values = [HEADER_ROW, toRow(lead('node/1')), [], toRow(lead('node/2'))];
  assert.equal(updatePlan(values, 'node/2', { tier: 'A' }).row, 4);
});

test('updating an unknown lead throws the same message the JSON store uses', () => {
  const values = [HEADER_ROW, toRow(lead('node/1'))];
  assert.throws(() => updatePlan(values, 'node/404', { tier: 'A' }), /No such lead: node\/404/);
});

test('a lead_id can never be matched against the header row', () => {
  // Paranoia with a point: "lead_id" in A1 must not be updatable as a lead.
  const values = [HEADER_ROW, toRow(lead('node/1'))];
  assert.throws(() => updatePlan(values, 'lead_id', {}), /No such lead/);
});

// ---- credentials ------------------------------------------------------------

test('a service-account key is parsed to the two fields a JWT needs', () => {
  const raw = JSON.stringify({
    type: 'service_account',
    client_email: 'pipeline@proj.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    project_id: 'proj',
  });
  const sa = parseServiceAccount(raw, 'key.json');
  assert.equal(sa.client_email, 'pipeline@proj.iam.gserviceaccount.com');
  assert.match(sa.private_key, /BEGIN PRIVATE KEY/);
});

test('an OAuth client file is rejected by name, not by a later 401', () => {
  const oauth = JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } });
  assert.throws(() => parseServiceAccount(oauth, 'key.json'), (err: Error) => {
    assert.match(err.message, /client_email/);
    assert.match(err.message, /private_key/);
    assert.match(err.message, /service-account/);
    return true;
  });
});

test('malformed key JSON names the file', () => {
  assert.throws(() => parseServiceAccount('{not json', 'creds/key.json'), /creds\/key\.json is not valid JSON/);
});
