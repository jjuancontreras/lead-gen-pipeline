import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestRefusal } from '../src/http.ts';

const PORT = 3008;
const ok = { host: `localhost:${PORT}` };

test('the console\'s own pages and API calls are allowed', () => {
  assert.equal(requestRefusal({ method: 'GET', path: '/pipeline', headers: ok }, PORT), null);
  assert.equal(requestRefusal({ method: 'GET', path: '/api/pipeline',
    headers: { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' } }, PORT), null);
  assert.equal(requestRefusal({ method: 'POST', path: '/api/pipeline/run',
    headers: { ...ok, 'content-type': 'application/json', origin: `http://localhost:${PORT}` } }, PORT), null);
  assert.equal(requestRefusal({ method: 'GET', path: '/api/leads',
    headers: { ...ok, 'sec-fetch-site': 'none' } }, PORT), null, 'typed into the address bar');
});

test('CRITICAL: DNS rebinding - a foreign Host header is refused on every route', () => {
  for (const path of ['/', '/api/pipeline', '/sites/x/']) {
    assert.match(requestRefusal({ method: 'GET', path, headers: { host: `evil.example:${PORT}` } }, PORT)!, /Host/);
  }
  assert.match(requestRefusal({ method: 'GET', path: '/', headers: { host: 'localhost:9999' } }, PORT)!, /Host/);
  assert.match(requestRefusal({ method: 'GET', path: '/', headers: {} }, PORT)!, /Host/);
});

test('CRITICAL: a cross-site request cannot reach the API, even a GET', () => {
  // GET /api/campaign starts a live campaign, so GETs need the check too.
  assert.match(requestRefusal({ method: 'GET', path: '/api/campaign',
    headers: { ...ok, 'sec-fetch-site': 'cross-site' } }, PORT)!, /cross-site/);
  assert.match(requestRefusal({ method: 'POST', path: '/api/pipeline/retry',
    headers: { ...ok, 'content-type': 'application/json', origin: 'https://evil.example' } }, PORT)!, /cross-origin/);
});

test('a POST must be JSON - a text/plain form cannot smuggle a body in', () => {
  assert.match(requestRefusal({ method: 'POST', path: '/api/pipeline/run',
    headers: { ...ok, 'content-type': 'text/plain' } }, PORT)!, /application\/json/);
  assert.match(requestRefusal({ method: 'POST', path: '/api/sent', headers: ok }, PORT)!, /application\/json/);
  assert.equal(requestRefusal({ method: 'POST', path: '/api/sent',
    headers: { ...ok, 'content-type': 'application/json; charset=utf-8' } }, PORT), null);
});
