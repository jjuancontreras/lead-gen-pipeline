/**
 * Thin Gemini REST client (text + vision), scoped to the free tier.
 *
 * Free-tier facts this module is built around (verified against Google's own
 * docs, not blog posts - many of those describe the paid tier):
 *   - No billing account required. Models: Gemini 3.x Flash / Flash-Lite,
 *     2.5 Flash / Flash-Lite. Roughly 10-30 RPM and 250-1500 RPD.
 *   - Grounding with Google Search is NOT available on the free tier - Gemini
 *     here only ever sees text/images a script already fetched, never the
 *     open web.
 *   - Vision IS free-tier eligible; that is the valuable part of this module.
 *   - Free-tier content is used to improve Google's products. Callers must
 *     only send PUBLIC business data (a scraped Instagram grid, a menu photo
 *     already posted publicly) - never client contracts or inbox contents.
 *
 * Plain `fetch` against the REST endpoint rather than `@google/genai`: this
 * package's only network dependency today is `undici`/native fetch (see
 * fetcher.ts, website.ts), adding an SDK for two endpoint shapes is not worth
 * a new dependency, and a hand-rolled request keeps the exact retry/backoff
 * and RPM pacing behaviour testable as pure functions below.
 *
 * Nothing in here reads process.env - callers pass `apiKey` explicitly, so a
 * missing key is a normal, testable `{ ok: false, reason: 'no-api-key' }`
 * result rather than a crash or a silent no-op.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** Change the model in exactly one place. gemini-2.5-flash is free-tier
 *  eligible, vision-capable, and has the friendliest free RPM of the
 *  general-purpose models - flash-lite trades quality for a higher ceiling
 *  if throughput ever becomes the bottleneck instead of quality. */
export const GEMINI_MODEL = 'gemini-2.5-flash';

/** Conservative default: comfortably under every published free-tier RPM
 *  figure (10-30) so a burst of curation + OCR calls for one harvest never
 *  needs to lean on retry-after-429 to behave. */
export const DEFAULT_RPM = 8;

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/* -------------------------------------------------------------------------- */
/* Response schema (subset of the JSON Schema Gemini's responseSchema takes)  */
/* -------------------------------------------------------------------------- */

export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly string[];
  nullable?: boolean;
}

/**
 * Validate `value` against `schema`, returning every violation found rather
 * than stopping at the first - one failed batch should tell the caller
 * everything wrong with it, not make them fix-and-retry N times.
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.nullable && value === null) return errors;

  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [`${path}: expected object, got ${describeType(value)}`];
      }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in obj)) errors.push(`${path}.${key}: required property missing`);
      }
      for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
        if (key in obj) errors.push(...validateAgainstSchema(obj[key], propSchema, `${path}.${key}`));
      }
      return errors;
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${path}: expected array, got ${describeType(value)}`];
      if (schema.items) {
        value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items!, `${path}[${i}]`)));
      }
      return errors;
    }
    case 'string': {
      if (typeof value !== 'string') return [`${path}: expected string, got ${describeType(value)}`];
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`${path}: "${value}" is not one of ${schema.enum.join(', ')}`);
      }
      return errors;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || Number.isNaN(value)) return [`${path}: expected number, got ${describeType(value)}`];
      if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path}: expected an integer, got ${value}`);
      return errors;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return [`${path}: expected boolean, got ${describeType(value)}`];
      return errors;
    }
    default:
      return [`${path}: unknown schema type`];
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/* -------------------------------------------------------------------------- */
/* Retry / backoff / rate limiting (pure)                                     */
/* -------------------------------------------------------------------------- */

/** HTTP statuses worth retrying. Everything else (400, 401, 403...) is a
 *  configuration problem a retry cannot fix. */
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Injectable for deterministic tests; defaults to Math.random. */
  rand?: () => number;
}

/**
 * Exponential backoff with full jitter (0..cap, not cap/2..cap): under a
 * shared free-tier 429, several harvest runs retrying in lockstep is worse
 * than each picking an independent delay.
 */
export function computeBackoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 20_000;
  const rand = opts.rand ?? Math.random;
  const cap = Math.min(max, base * 2 ** attempt);
  return Math.round(rand() * cap);
}

/**
 * How long to wait before the next call given an RPM budget and when the
 * last call started. Pure so the pacing decision itself - not just the sleep
 * - is unit tested.
 */
export function minIntervalMs(rpm: number): number {
  return rpm > 0 ? Math.ceil(60_000 / rpm) : 0;
}

export function waitBeforeNextCall(lastCallAt: number | null, now: number, rpm: number): number {
  if (lastCallAt === null) return 0;
  const interval = minIntervalMs(rpm);
  const elapsed = now - lastCallAt;
  return Math.max(0, interval - elapsed);
}

/* -------------------------------------------------------------------------- */
/* Request / response shapes (pure builders + parsers, unit-tested directly)  */
/* -------------------------------------------------------------------------- */

export interface InlineImagePart {
  mimeType: string;
  /** Base64-encoded bytes. */
  data: string;
}

export interface GenerateContentRequestOptions {
  prompt: string;
  schema: JsonSchema;
  systemInstruction?: string;
  images?: InlineImagePart[];
  temperature?: number;
}

/** Gemini's `generateContent` request body. Exported so tests can assert its
 *  exact shape against the documented REST contract without a live call. */
export interface GeminiRequestBody {
  contents: { role: 'user'; parts: Array<{ text: string } | { inlineData: InlineImagePart }> }[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig: {
    responseMimeType: 'application/json';
    responseSchema: JsonSchema;
    temperature?: number;
  };
}

export function buildGenerateContentRequest(opts: GenerateContentRequestOptions): GeminiRequestBody {
  const parts: GeminiRequestBody['contents'][0]['parts'] = [{ text: opts.prompt }];
  for (const image of opts.images ?? []) parts.push({ inlineData: image });

  const body: GeminiRequestBody = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: opts.schema,
    },
  };
  if (opts.systemInstruction) body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  if (opts.temperature !== undefined) body.generationConfig.temperature = opts.temperature;
  return body;
}

export function endpointUrl(model: string, apiKey: string): string {
  return `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

/** Shape of a successful `generateContent` REST response, trimmed to the
 *  fields this client reads. */
export interface GeminiApiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

/**
 * Pull the model's text out of a parsed response body. Isolated from JSON
 * parsing and schema validation so each failure mode - "not JSON at all",
 * "valid JSON but empty candidates", "blocked by safety filters" - gets its
 * own message instead of one generic "bad response".
 */
export function extractResponseText(body: GeminiApiResponse): { ok: true; text: string } | { ok: false; reason: string } {
  if (body.promptFeedback?.blockReason) {
    return { ok: false, reason: `blocked: ${body.promptFeedback.blockReason}` };
  }
  const candidate = body.candidates?.[0];
  if (!candidate) return { ok: false, reason: 'no candidates in response' };
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    return { ok: false, reason: `finished with reason "${candidate.finishReason}", not STOP` };
  }
  const text = candidate.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text.trim()) return { ok: false, reason: 'response had no text' };
  return { ok: true, text };
}

/** Parse the model's text as JSON and validate it against the schema. Never
 *  hands a caller unvalidated `any` - a parse or schema failure is reported,
 *  not swallowed into a best-effort cast. */
export function parseAndValidate<T>(
  text: string,
  schema: JsonSchema,
): { ok: true; data: T } | { ok: false; reason: string; errors?: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `model output was not valid JSON: ${(err as Error).message}` };
  }
  const errors = validateAgainstSchema(parsed, schema);
  if (errors.length > 0) return { ok: false, reason: 'model output did not match the response schema', errors };
  return { ok: true, data: parsed as T };
}

/* -------------------------------------------------------------------------- */
/* Image loading                                                              */
/* -------------------------------------------------------------------------- */

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
};

/** File extension -> MIME type Gemini accepts for inline image parts. */
export function mimeTypeForPath(path: string): string | null {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? null;
}

export async function loadImagePart(path: string): Promise<InlineImagePart> {
  const mimeType = mimeTypeForPath(path);
  if (!mimeType) {
    throw new Error(`${path}: unsupported image type (expected .jpg, .jpeg, .png or .webp)`);
  }
  const bytes = await readFile(path);
  return { mimeType, data: bytes.toString('base64') };
}

/* -------------------------------------------------------------------------- */
/* Public network entry points                                                */
/* -------------------------------------------------------------------------- */

export type GeminiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: 'no-api-key' | 'http-error' | 'blocked' | 'invalid-response' | 'network-error';
      detail: string;
    };

export interface GenerateJsonOptions<T> {
  /** Undefined/empty means "no key configured" - a clean, expected result,
   *  never a thrown error. Callers read this from process.env themselves so
   *  this module never touches env directly. */
  apiKey: string | undefined;
  prompt: string;
  schema: JsonSchema;
  systemInstruction?: string;
  images?: InlineImagePart[];
  model?: string;
  rpm?: number;
  maxRetries?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests to avoid real sleeps. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Wall-clock timestamp of the previous call under the same rate limiter,
   *  so pacing can be verified without real time passing. */
  lastCallAt?: number | null;
  onRateLimited?: (waitMs: number) => void;
  // T is used only for the return type; expressed via a phantom parameter is
  // unnecessary here since generateJson<T> below supplies it explicitly.
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Text-in, validated-JSON-out call against Gemini's free tier.
 *
 * Guarded behind `apiKey`: with no key this resolves to
 * `{ ok: false, reason: 'no-api-key' }` immediately, no network attempted.
 * On 429/5xx it retries with exponential backoff, honouring an RPM budget
 * between attempts so a caller doing several calls in a row does not hammer
 * the free tier's per-minute limit.
 */
export async function generateJson<T>(opts: GenerateJsonOptions<T>): Promise<GeminiResult<T>> {
  if (!opts.apiKey) {
    return { ok: false, reason: 'no-api-key', detail: 'GEMINI_API_KEY is not set - skipping Gemini call.' };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const model = opts.model ?? GEMINI_MODEL;
  const rpm = opts.rpm ?? DEFAULT_RPM;
  const maxRetries = opts.maxRetries ?? 3;
  const body = buildGenerateContentRequest(opts);
  const url = endpointUrl(model, opts.apiKey);

  let lastCallAt = opts.lastCallAt ?? null;
  let lastErrorDetail = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const wait = waitBeforeNextCall(lastCallAt, Date.now(), rpm);
    if (wait > 0) {
      opts.onRateLimited?.(wait);
      await sleep(wait);
    }
    lastCallAt = Date.now();

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErrorDetail = (err as Error).message;
      if (attempt === maxRetries) return { ok: false, reason: 'network-error', detail: lastErrorDetail };
      await sleep(computeBackoffMs(attempt));
      continue;
    }

    if (!res.ok) {
      lastErrorDetail = `HTTP ${res.status}: ${await safeText(res)}`;
      if (isRetryableStatus(res.status) && attempt < maxRetries) {
        await sleep(computeBackoffMs(attempt));
        continue;
      }
      return { ok: false, reason: 'http-error', detail: lastErrorDetail };
    }

    let parsedBody: GeminiApiResponse;
    try {
      parsedBody = (await res.json()) as GeminiApiResponse;
    } catch (err) {
      return { ok: false, reason: 'invalid-response', detail: `response was not JSON: ${(err as Error).message}` };
    }

    const extracted = extractResponseText(parsedBody);
    if (!extracted.ok) {
      return { ok: false, reason: extracted.reason.startsWith('blocked') ? 'blocked' : 'invalid-response', detail: extracted.reason };
    }

    const validated = parseAndValidate<T>(extracted.text, opts.schema);
    if (!validated.ok) {
      return {
        ok: false,
        reason: 'invalid-response',
        detail: validated.errors ? `${validated.reason}: ${validated.errors.join('; ')}` : validated.reason,
      };
    }
    return { ok: true, data: validated.data };
  }

  return { ok: false, reason: 'network-error', detail: lastErrorDetail || 'exhausted retries' };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}

export interface GenerateFromImagesOptions<T> extends Omit<GenerateJsonOptions<T>, 'images'> {
  imagePaths: string[];
}

/**
 * Vision call: reads local image files, base64-encodes them, and delegates
 * to `generateJson`. Kept separate from `generateJson` so the file-reading
 * step has one clear place to fail with a per-file message.
 */
export async function generateFromImages<T>(opts: GenerateFromImagesOptions<T>): Promise<GeminiResult<T>> {
  if (!opts.apiKey) {
    return { ok: false, reason: 'no-api-key', detail: 'GEMINI_API_KEY is not set - skipping Gemini call.' };
  }
  const images: InlineImagePart[] = [];
  for (const path of opts.imagePaths) {
    try {
      images.push(await loadImagePart(path));
    } catch (err) {
      return { ok: false, reason: 'network-error', detail: (err as Error).message };
    }
  }
  const { imagePaths: _imagePaths, ...rest } = opts;
  return generateJson<T>({ ...rest, images });
}
