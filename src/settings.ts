/**
 * Every environment setting, read once and validated.
 *
 * A bad value fails at startup, and the error names the setting. The failure
 * this replaces is a typo such as `PIPELINE_STORE=sheet` or `SEND_EMAILS=flase`
 * being quietly read as the default.
 *
 * `.env.local` is loaded first (see env.ts). Real environment variables win.
 */
import './env.ts';
import { resolve } from 'node:path';
import { z } from 'zod';
import { findPackageRoot } from './root.ts';

const FALSE_WORDS = new Set(['', 'false', '0', 'no', 'off']);
const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);

const optionalText = z.string().trim().transform((v) => (v === '' ? undefined : v)).optional();

const positiveInt = (fallback: number) => z.string().trim().default(String(fallback))
  .refine((v) => /^\d+$/.test(v) && Number(v) > 0, 'must be a positive whole number')
  .transform(Number);

const Env = z.object({
  PIPELINE_DATA_DIR: optionalText,
  PIPELINE_STORE: z.enum(['auto', 'json']).default('auto'),
  // Sending is not a feature of this codebase: every message is a draft a
  // person reads and sends. The switch exists so that any send path has one
  // place to check - and it refuses to turn on while no transport exists.
  SEND_EMAILS: z.string().trim().toLowerCase().default('false')
    .refine((v) => FALSE_WORDS.has(v) || TRUE_WORDS.has(v), 'must be true or false')
    .refine((v) => !TRUE_WORDS.has(v),
      'is true, but this build has no mail transport - drafts only. Set SEND_EMAILS=false.')
    .transform(() => false as const),
  SENDER_NAME: optionalText,
  SENDER_EMAIL: optionalText.pipe(z.email().optional()),
  PUBLIC_BASE_URL: z.url().default('http://localhost:3008')
    .refine((v) => /^https?:\/\//.test(v), 'must be an http(s) URL')
    .transform((v) => v.replace(/\/+$/, '')),
  DEMO_SITES_ROOT: optionalText,
  PIPELINE_VIDEO_MS: positiveInt(27_000),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface Settings {
  root: string;
  dataDir: string;
  store: 'auto' | 'json';
  sendEmails: false;
  senderName?: string;
  senderEmail?: string;
  publicBaseUrl: string;
  /** Where scaffolded Next.js demos live (one folder per slug). */
  demoSitesRoot: string;
  /** Target length of a walkthrough video. */
  videoMs: number;
  logFormat: 'pretty' | 'json';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/** Pure: validate an environment. Throws one error listing every bad setting. */
export function parseSettings(
  env: Readonly<Record<string, string | undefined>>,
  root: string,
): Settings {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid settings:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    root,
    dataDir: resolve(root, e.PIPELINE_DATA_DIR ?? 'data'),
    store: e.PIPELINE_STORE,
    sendEmails: e.SEND_EMAILS,
    senderName: e.SENDER_NAME,
    senderEmail: e.SENDER_EMAIL,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    demoSitesRoot: resolve(root, e.DEMO_SITES_ROOT ?? '..'),
    videoMs: e.PIPELINE_VIDEO_MS,
    logFormat: e.LOG_FORMAT,
    logLevel: e.LOG_LEVEL,
  };
}

let cached: Settings | null = null;

/** The process's settings, validated on first use. */
export function settings(): Settings {
  cached ??= parseSettings(process.env, findPackageRoot());
  return cached;
}
