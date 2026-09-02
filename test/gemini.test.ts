import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAgainstSchema,
  computeBackoffMs,
  minIntervalMs,
  waitBeforeNextCall,
  isRetryableStatus,
  buildGenerateContentRequest,
  endpointUrl,
  extractResponseText,
  parseAndValidate,
  mimeTypeForPath,
  generateJson,
  generateFromImages,
  type JsonSchema,
  type GeminiApiResponse,
} from '../src/gemini.ts';

/* -------------------------------------------------------------------------- */
/* Schema validation                                                          */
/* -------------------------------------------------------------------------- */

const PERSON_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['name', 'age'],
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
    role: { type: 'string', enum: ['admin', 'member'] },
  },
};

test('validateAgainstSchema accepts a matching object', () => {
  const errors = validateAgainstSchema({ name: 'Kuro', age: 3, role: 'admin' }, PERSON_SCHEMA);
  assert.deepEqual(errors, []);
});

test('validateAgainstSchema reports every missing required field, not just the first', () => {
  const errors = validateAgainstSchema({}, PERSON_SCHEMA);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.includes('name')));
  assert.ok(errors.some((e) => e.includes('age')));
});

test('validateAgainstSchema rejects a wrong primitive type with a readable message', () => {
  const errors = validateAgainstSchema({ name: 'Kuro', age: '3' }, PERSON_SCHEMA);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /age.*expected number, got string/);
});

test('validateAgainstSchema enforces enum membership', () => {
  const errors = validateAgainstSchema({ name: 'Kuro', age: 3, role: 'owner' }, PERSON_SCHEMA);
  assert.match(errors[0]!, /not one of admin, member/);
});

test('validateAgainstSchema recurses into arrays and nested objects', () => {
  const schema: JsonSchema = {
    type: 'object',
    required: ['items'],
    properties: {
      items: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
    },
  };
  const errors = validateAgainstSchema({ items: [{ name: 'a' }, {}] }, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /items\[1\]\.name/);
});

test('validateAgainstSchema treats an array where an object is expected as a type error', () => {
  const errors = validateAgainstSchema([], PERSON_SCHEMA);
  assert.match(errors[0]!, /expected object, got array/);
});

test('validateAgainstSchema nullable lets null through', () => {
  const schema: JsonSchema = { type: 'string', nullable: true };
  assert.deepEqual(validateAgainstSchema(null, schema), []);
});

/* -------------------------------------------------------------------------- */
/* Retry / backoff / rate limiting                                            */
/* -------------------------------------------------------------------------- */

test('isRetryableStatus is true for 429 and 5xx, false for 4xx config errors', () => {
  for (const s of [429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [400, 401, 403, 404]) assert.equal(isRetryableStatus(s), false, String(s));
});

test('computeBackoffMs grows exponentially and stays within [0, cap]', () => {
  const rand = () => 1; // pin jitter to the cap to make growth assertable
  const a0 = computeBackoffMs(0, { baseMs: 1000, maxMs: 20_000, rand });
  const a1 = computeBackoffMs(1, { baseMs: 1000, maxMs: 20_000, rand });
  const a2 = computeBackoffMs(2, { baseMs: 1000, maxMs: 20_000, rand });
  assert.equal(a0, 1000);
  assert.equal(a1, 2000);
  assert.equal(a2, 4000);
});

test('computeBackoffMs never exceeds maxMs even at a high attempt count', () => {
  const value = computeBackoffMs(20, { baseMs: 1000, maxMs: 20_000, rand: () => 1 });
  assert.equal(value, 20_000);
});

test('minIntervalMs converts an RPM budget into a per-call spacing', () => {
  assert.equal(minIntervalMs(60), 1000);
  assert.equal(minIntervalMs(6), 10_000);
  assert.equal(minIntervalMs(0), 0);
});

test('waitBeforeNextCall is zero for the first call ever', () => {
  assert.equal(waitBeforeNextCall(null, Date.now(), 8), 0);
});

test('waitBeforeNextCall waits out the remainder of the RPM interval', () => {
  const rpm = 6; // one call per 10s
  const wait = waitBeforeNextCall(1000, 4000, rpm);
  assert.equal(wait, 7000);
});

test('waitBeforeNextCall never returns negative once the interval has already elapsed', () => {
  assert.equal(waitBeforeNextCall(0, 999_999, 60), 0);
});

/* -------------------------------------------------------------------------- */
/* Request building                                                           */
/* -------------------------------------------------------------------------- */

test('buildGenerateContentRequest sets responseMimeType and embeds the schema', () => {
  const body = buildGenerateContentRequest({ prompt: 'hello', schema: PERSON_SCHEMA });
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema, PERSON_SCHEMA);
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
});

test('buildGenerateContentRequest appends image parts after the text part, in order', () => {
  const images = [{ mimeType: 'image/jpeg', data: 'AAA' }, { mimeType: 'image/png', data: 'BBB' }];
  const body = buildGenerateContentRequest({ prompt: 'describe these', schema: PERSON_SCHEMA, images });
  assert.deepEqual(body.contents[0]!.parts, [
    { text: 'describe these' },
    { inlineData: images[0] },
    { inlineData: images[1] },
  ]);
});

test('buildGenerateContentRequest only sets systemInstruction when provided', () => {
  const withSys = buildGenerateContentRequest({ prompt: 'x', schema: PERSON_SCHEMA, systemInstruction: 'be terse' });
  assert.deepEqual(withSys.systemInstruction, { parts: [{ text: 'be terse' }] });
  const withoutSys = buildGenerateContentRequest({ prompt: 'x', schema: PERSON_SCHEMA });
  assert.equal(withoutSys.systemInstruction, undefined);
});

test('endpointUrl embeds the model and key as documented by the REST API', () => {
  const url = endpointUrl('gemini-2.5-flash', 'my key/with+chars');
  assert.equal(
    url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=my%20key%2Fwith%2Bchars',
  );
});

/* -------------------------------------------------------------------------- */
/* Response parsing - realistic hand-written fixture payloads                 */
/* -------------------------------------------------------------------------- */

test('extractResponseText reads the concatenated text of a normal STOP response', () => {
  const body: GeminiApiResponse = {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"name":"Kuro"' }, { text: ',"age":3}' }] } }],
  };
  const result = extractResponseText(body);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.text, '{"name":"Kuro","age":3}');
});

test('extractResponseText reports a safety block distinctly from an empty response', () => {
  const blocked = extractResponseText({ promptFeedback: { blockReason: 'SAFETY' } });
  assert.equal(blocked.ok, false);
  assert.match(!blocked.ok ? blocked.reason : '', /blocked: SAFETY/);
});

test('extractResponseText reports a non-STOP finish reason (e.g. MAX_TOKENS)', () => {
  const truncated = extractResponseText({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"a"' }] } }] });
  assert.equal(truncated.ok, false);
  assert.match(!truncated.ok ? truncated.reason : '', /MAX_TOKENS/);
});

test('extractResponseText reports no candidates', () => {
  const empty = extractResponseText({});
  assert.equal(empty.ok, false);
});

test('parseAndValidate turns valid model JSON into typed, validated data', () => {
  const result = parseAndValidate<{ name: string; age: number }>('{"name":"Kuro","age":3}', PERSON_SCHEMA);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.data : null, { name: 'Kuro', age: 3 });
});

test('parseAndValidate reports malformed JSON without throwing', () => {
  const result = parseAndValidate('not json {{', PERSON_SCHEMA);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : '', /not valid JSON/);
});

test('parseAndValidate reports schema violations with the specific errors', () => {
  const result = parseAndValidate('{"name":"Kuro"}', PERSON_SCHEMA);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors?.some((e) => e.includes('age')));
});

/* -------------------------------------------------------------------------- */
/* Image mime typing                                                          */
/* -------------------------------------------------------------------------- */

test('mimeTypeForPath maps known extensions and rejects unknown ones', () => {
  assert.equal(mimeTypeForPath('photo.jpg'), 'image/jpeg');
  assert.equal(mimeTypeForPath('photo.JPEG'), 'image/jpeg');
  assert.equal(mimeTypeForPath('photo.png'), 'image/png');
  assert.equal(mimeTypeForPath('photo.webp'), 'image/webp');
  assert.equal(mimeTypeForPath('photo.gif'), null);
});

/* -------------------------------------------------------------------------- */
/* generateJson: the guard behind the missing key, and the retry/parse path,  */
/* driven entirely through an injected fetch fixture - no real network call.  */
/* -------------------------------------------------------------------------- */

test('generateJson never attempts a network call with no apiKey', async () => {
  let called = false;
  const result = await generateJson<{ name: string; age: number }>({
    apiKey: undefined,
    prompt: 'x',
    schema: PERSON_SCHEMA,
    fetchImpl: (async () => { called = true; throw new Error('should not be called'); }) as unknown as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'no-api-key');
  assert.equal(called, false);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('generateJson returns validated data on a clean fixture response', async () => {
  const fixture: GeminiApiResponse = {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"name":"Kuro","age":3}' }] } }],
  };
  const result = await generateJson<{ name: string; age: number }>({
    apiKey: 'test-key',
    prompt: 'x',
    schema: PERSON_SCHEMA,
    fetchImpl: (async () => jsonResponse(200, fixture)) as unknown as typeof fetch,
    sleepImpl: async () => {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.data : null, { name: 'Kuro', age: 3 });
});

test('generateJson retries a 429 and succeeds on the next attempt', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response('rate limited', { status: 429 });
    const fixture: GeminiApiResponse = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"name":"Kuro","age":3}' }] } }] };
    return jsonResponse(200, fixture);
  }) as unknown as typeof fetch;

  const result = await generateJson<{ name: string; age: number }>({
    apiKey: 'test-key',
    prompt: 'x',
    schema: PERSON_SCHEMA,
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('generateJson gives up after maxRetries and reports the last HTTP error', async () => {
  const fetchImpl = (async () => new Response('server exploded', { status: 503 })) as unknown as typeof fetch;
  const result = await generateJson<{ name: string; age: number }>({
    apiKey: 'test-key',
    prompt: 'x',
    schema: PERSON_SCHEMA,
    fetchImpl,
    sleepImpl: async () => {},
    maxRetries: 2,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'http-error');
  assert.match(!result.ok ? result.detail : '', /503/);
});

test('generateJson does not retry a 400 - it is a config problem, not a transient one', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response('bad request', { status: 400 }); }) as unknown as typeof fetch;
  const result = await generateJson<{ name: string; age: number }>({
    apiKey: 'test-key',
    prompt: 'x',
    schema: PERSON_SCHEMA,
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test('generateJson reports a schema mismatch as invalid-response rather than crashing', async () => {
  const fixture: GeminiApiResponse = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"name":"Kuro"}' }] } }] };
  const result = await generateJson<{ name: string; age: number }>({
    apiKey: 'test-key',
    prompt: 'x',
    schema: PERSON_SCHEMA,
    fetchImpl: (async () => jsonResponse(200, fixture)) as unknown as typeof fetch,
    sleepImpl: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'invalid-response');
});

test('generateJson honours the RPM budget between calls', async () => {
  const sleeps: number[] = [];
  const fixture: GeminiApiResponse = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"name":"Kuro","age":3}' }] } }] };
  await generateJson<{ name: string; age: number }>({
    apiKey: 'test-key',
    prompt: 'x',
    schema: PERSON_SCHEMA,
    rpm: 6, // 10s spacing
    lastCallAt: Date.now() - 1000, // 9s still owed
    fetchImpl: (async () => jsonResponse(200, fixture)) as unknown as typeof fetch,
    sleepImpl: async (ms: number) => { sleeps.push(ms); },
    onRateLimited: (ms) => sleeps.push(ms),
  });
  assert.ok(sleeps.length > 0, 'expected at least one throttling sleep');
  assert.ok(sleeps[0]! > 8000 && sleeps[0]! <= 9000, `expected ~9s wait, got ${sleeps[0]}`);
});

test('generateFromImages is guarded behind apiKey exactly like generateJson', async () => {
  const result = await generateFromImages<{ name: string; age: number }>({
    apiKey: undefined,
    imagePaths: ['/does/not/matter.jpg'],
    prompt: 'x',
    schema: PERSON_SCHEMA,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'no-api-key');
});

test('generateFromImages reports a missing file without throwing', async () => {
  const result = await generateFromImages<{ name: string; age: number }>({
    apiKey: 'test-key',
    imagePaths: ['/definitely/does/not/exist.jpg'],
    prompt: 'x',
    schema: PERSON_SCHEMA,
    fetchImpl: (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch,
  });
  assert.equal(result.ok, false);
});
