import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gmailCredsUsable } from '../src/gmail-creds.ts';

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
