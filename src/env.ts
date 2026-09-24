/**
 * Loads `.env.local` into process.env, once, on first import.
 *
 * Without this the whole credential story is a lie: `.gitignore` excludes
 * `.env.local` and the setup docs tell you to create it, but nothing read
 * it — you would paste in a Gemini key, see no error, and silently keep
 * getting the no-key degradation path forever. That is the worst kind of
 * bug: the system looks like it is working.
 *
 * Uses Node's built-in parser (`process.loadEnvFile`, Node 20.12+) rather
 * than adding a dependency.
 *
 * Real environment variables always win over the file, so CI or a shell
 * export can override without editing anything on disk.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findPackageRoot } from './root.ts';

const envFile = resolve(findPackageRoot(), '.env.local');

let loaded = false;

export function loadLocalEnv(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(envFile)) return;

  // Snapshot what the real environment already set, so the file cannot
  // clobber an explicit export.
  const preexisting = new Set(Object.keys(process.env));
  const before = new Map(Object.entries(process.env));

  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    // A malformed .env.local should be loud, not silently ignored - the
    // symptom otherwise is "my key does nothing".
    console.warn(`  warning: could not read .env.local - ${(err as Error).message}`);
    return;
  }

  for (const key of preexisting) {
    const original = before.get(key);
    if (original !== undefined && process.env[key] !== original) {
      process.env[key] = original;
    }
  }
}

/** Names every credential the pipeline understands, for the doctor command. */
export const CREDENTIALS = [
  { key: 'GEMINI_API_KEY', unlocks: 'photo curation, menu OCR, palette description' },
  { key: 'GOOGLE_SHEET_ID', unlocks: 'Google Sheets store (with GOOGLE_SA_KEY_PATH)' },
  { key: 'GOOGLE_SA_KEY_PATH', unlocks: 'Google Sheets store (with GOOGLE_SHEET_ID)' },
  { key: 'GOOGLE_SHEET_TAB', unlocks: 'optional: sheet tab name, defaults to "Leads"' },
  { key: 'GMAIL_TOKEN_PATH', unlocks: 'Gmail drafts (otherwise drafts are written to files)' },
] as const;

loadLocalEnv();
