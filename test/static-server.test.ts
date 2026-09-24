import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveStatic, startStaticServer, contentType } from '../src/static-server.ts';

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'pl-static-'));
  mkdirSync(join(root, 'site-a'));
  writeFileSync(join(root, 'site-a', 'index.html'), '<!DOCTYPE html><title>a</title>');
  writeFileSync(join(root, 'clip.mp4'), Buffer.alloc(1000, 7));
  writeFileSync(join(root, '..', 'outside-secret.txt'), 'secret');
  return root;
}

test('a directory resolves to its index.html', () => {
  const root = tree();
  assert.equal(resolveStatic(root, '/site-a/'), join(root, 'site-a', 'index.html'));
});

test('CRITICAL: a path that escapes the root is refused', () => {
  const root = tree();
  assert.equal(resolveStatic(root, '/../outside-secret.txt'), null);
  assert.equal(resolveStatic(root, '/%2e%2e/outside-secret.txt'), null);
  assert.equal(resolveStatic(root, '/site-a/..%2f..%2foutside-secret.txt'), null);
  assert.equal(resolveStatic(root, '/%00'), null);
  assert.equal(resolveStatic(root, '/%E0%A4%A'), null, 'malformed escapes are refused, not thrown');
});

test('a missing file is null', () => {
  assert.equal(resolveStatic(tree(), '/nope.html'), null);
});

test('content types cover what the pipeline serves', () => {
  assert.equal(contentType('a/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('v.mp4'), 'video/mp4');
  assert.equal(contentType('x.bin'), 'application/octet-stream');
});

test('the server serves files, 404s the rest, and honours a byte range', async () => {
  const root = tree();
  const server = await startStaticServer(root);
  try {
    const page = await fetch(`${server.url}/site-a/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>a<\/title>/);

    assert.equal((await fetch(`${server.url}/missing`)).status, 404);

    const part = await fetch(`${server.url}/clip.mp4`, { headers: { Range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
    assert.equal((await part.arrayBuffer()).byteLength, 100);

    const bad = await fetch(`${server.url}/clip.mp4`, { headers: { Range: 'bytes=5000-' } });
    assert.equal(bad.status, 416);
  } finally {
    await server.close();
  }
});
