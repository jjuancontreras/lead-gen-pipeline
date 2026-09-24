import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { parseSettings } from '../src/settings.ts';
import { findPackageRoot } from '../src/root.ts';

const ROOT = findPackageRoot();

test('defaults: data under the repo, auto store, sending off, local links', () => {
  const s = parseSettings({}, ROOT);
  assert.equal(s.dataDir, resolve(ROOT, 'data'));
  assert.equal(s.store, 'auto');
  assert.equal(s.sendEmails, false);
  assert.equal(s.publicBaseUrl, 'http://localhost:3008');
  assert.equal(s.senderEmail, undefined);
  assert.equal(s.logFormat, 'pretty');
  assert.equal(s.logLevel, 'info');
  assert.equal(s.demoSitesRoot, resolve(ROOT, '..'));
  assert.equal(s.consolePort, 3008);
});

test('PIPELINE_DATA_DIR is resolved against the repo root, not the cwd', () => {
  const s = parseSettings({ PIPELINE_DATA_DIR: 'tmp/run-1' }, ROOT);
  assert.equal(s.dataDir, resolve(ROOT, 'tmp/run-1'));
});

test('SEND_EMAILS=true is refused - no mail transport exists', () => {
  assert.throws(() => parseSettings({ SEND_EMAILS: 'true' }, ROOT), /SEND_EMAILS/);
  assert.throws(() => parseSettings({ SEND_EMAILS: '1' }, ROOT), /SEND_EMAILS/);
});

test('SEND_EMAILS accepts every spelling of false', () => {
  for (const v of ['false', '0', '', 'FALSE', 'no']) {
    assert.equal(parseSettings({ SEND_EMAILS: v }, ROOT).sendEmails, false, v);
  }
});

test('a typo in SEND_EMAILS is an error, not a silent default', () => {
  assert.throws(() => parseSettings({ SEND_EMAILS: 'flase' }, ROOT), /SEND_EMAILS/);
});

test('bad values name the setting that is wrong', () => {
  assert.throws(() => parseSettings({ PIPELINE_STORE: 'sheet' }, ROOT), /PIPELINE_STORE/);
  assert.throws(() => parseSettings({ SENDER_EMAIL: 'not-an-address' }, ROOT), /SENDER_EMAIL/);
  assert.throws(() => parseSettings({ PUBLIC_BASE_URL: 'localhost' }, ROOT), /PUBLIC_BASE_URL/);
  assert.throws(() => parseSettings({ LOG_LEVEL: 'loud' }, ROOT), /LOG_LEVEL/);
  assert.throws(() => parseSettings({ PIPELINE_VIDEO_MS: '-5' }, ROOT), /PIPELINE_VIDEO_MS/);
  assert.throws(() => parseSettings({ CONSOLE_PORT: '70000' }, ROOT), /CONSOLE_PORT/);
  assert.equal(parseSettings({ CONSOLE_PORT: '0' }, ROOT).consolePort, 0);
});

test('an empty SENDER_EMAIL means unset, not invalid', () => {
  assert.equal(parseSettings({ SENDER_EMAIL: '  ' }, ROOT).senderEmail, undefined);
});

test('PUBLIC_BASE_URL loses its trailing slash so links join cleanly', () => {
  assert.equal(parseSettings({ PUBLIC_BASE_URL: 'https://demo.example.com/' }, ROOT).publicBaseUrl,
    'https://demo.example.com');
});

test('findPackageRoot finds the directory holding package.json', () => {
  assert.ok(existsSync(resolve(ROOT, 'package.json')));
  assert.ok(existsSync(resolve(ROOT, 'config', 'areas.json')));
});
