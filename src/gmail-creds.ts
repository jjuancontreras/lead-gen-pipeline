/** Gmail OAuth token file: loading and a throw-free usability probe. */
import './env.ts';
import { readFileSync } from 'node:fs';

export interface GmailCreds { client_id: string; client_secret: string; refresh_token: string }

function extract(json: Record<string, unknown>): GmailCreds {
  const nested = (json.installed ?? json.web ?? {}) as Record<string, unknown>;
  const pick = (k: string) => String(json[k] ?? nested[k] ?? '').trim();
  return {
    client_id: pick('client_id'),
    client_secret: pick('client_secret'),
    refresh_token: pick('refresh_token'),
  };
}

/**
 * Read the OAuth token file. Accepts a flat `{client_id, client_secret,
 * refresh_token}` or Google's downloaded `{installed: {...}}` shape with the
 * refresh token merged in, because both are what people actually end up with.
 */
export function loadGmailCreds(path: string): GmailCreds {
  const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const creds = extract(json);
  const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) throw new Error(`${path} is missing: ${missing.join(', ')}`);
  return creds;
}

/**
 * Whether `path` is a usable Gmail token file. Never throws: any error -
 * missing file, bad JSON, missing field - is just `false`.
 */
export function gmailCredsUsable(path: string): boolean {
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const creds = extract(json);
    return Boolean(creds.client_id && creds.client_secret && creds.refresh_token);
  } catch {
    return false;
  }
}

/**
 * Whether outreach can create Gmail drafts right now. False means drafts go
 * to files instead - the documented fallback, not an error.
 */
export function gmailReady(): boolean {
  const path = process.env.GMAIL_TOKEN_PATH;
  return path ? gmailCredsUsable(path) : false;
}
