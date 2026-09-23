import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gmailCredsUsable, gmailReady } from '../src/gmail-creds.ts';

test('gmailReady follows GMAIL_TOKEN_PATH: unset or unusable is false, a real token is true', () => {
  const saved = process.env.GMAIL_TOKEN_PATH;
  const dir = mkdtempSync(join(tmpdir(), 'gmail-ready-test-'));
  try {
    delete process.env.GMAIL_TOKEN_PATH;
    assert.equal(gmailReady(), false);

    const clientOnly = join(dir, 'client.json');
    writeFileSync(clientOnly, JSON.stringify({ installed: { client_id: 'id', client_secret: 's' } }));
    process.env.GMAIL_TOKEN_PATH = clientOnly;
    assert.equal(gmailReady(), false, 'an OAuth client file has no refresh_token');

    const token = join(dir, 'token.json');
    writeFileSync(token, JSON.stringify({ client_id: 'id', client_secret: 's', refresh_token: 'r' }));
    process.env.GMAIL_TOKEN_PATH = token;
    assert.equal(gmailReady(), true);
  } finally {
    if (saved === undefined) delete process.env.GMAIL_TOKEN_PATH;
    else process.env.GMAIL_TOKEN_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gmailCredsUsable returns false for a non-existent path', () => {
  const path = join(tmpdir(), 'nonexistent-creds-file-for-test.json');
  assert.equal(gmailCredsUsable(path), false);
});

test('gmailCredsUsable returns false for invalid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-creds-test-'));
  try {
    const path = join(dir, 'invalid.json');
    writeFileSync(path, '{invalid json content}');
    assert.equal(gmailCredsUsable(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gmailCredsUsable returns false when refresh_token is missing from flat object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-creds-test-'));
  try {
    const path = join(dir, 'creds.json');
    writeFileSync(path, JSON.stringify({
      client_id: 'test-id',
      client_secret: 'test-secret',
    }));
    assert.equal(gmailCredsUsable(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gmailCredsUsable returns false when refresh_token is missing from nested installed object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-creds-test-'));
  try {
    const path = join(dir, 'creds.json');
    writeFileSync(path, JSON.stringify({
      installed: {
        client_id: 'test-id',
        client_secret: 'test-secret',
      },
    }));
    assert.equal(gmailCredsUsable(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gmailCredsUsable returns true for a valid flat object with all required fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-creds-test-'));
  try {
    const path = join(dir, 'creds.json');
    writeFileSync(path, JSON.stringify({
      client_id: 'test-id',
      client_secret: 'test-secret',
      refresh_token: '1//0abc123def',
    }));
    assert.equal(gmailCredsUsable(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gmailCredsUsable returns true when refresh_token is at top level with nested installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-creds-test-'));
  try {
    const path = join(dir, 'creds.json');
    writeFileSync(path, JSON.stringify({
      installed: {
        client_id: 'test-id',
        client_secret: 'test-secret',
      },
      refresh_token: '1//0abc123def',
    }));
    assert.equal(gmailCredsUsable(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
