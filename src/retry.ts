/**
 * Retries with backoff, and timeouts, for anything that leaves the process.
 *
 * Every attempt gets its own AbortSignal. A timed-out attempt is aborted, so a
 * hung browser page or HTTP request is actually cancelled rather than left
 * running behind the retry.
 */

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Injectable for deterministic tests; defaults to Math.random. */
  rand?: () => number;
}

/**
 * Exponential backoff with full jitter (0..cap, not cap/2..cap): several
 * callers retrying in lockstep against one rate limit is worse than each
 * picking an independent delay.
 */
export function computeBackoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 20_000;
  const rand = opts.rand ?? Math.random;
  const cap = Math.min(max, base * 2 ** attempt);
  return Math.round(rand() * cap);
}

/** Run `fn`, aborting it and rejecting with TimeoutError after `ms`. */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new TimeoutError(label, ms);
      ac.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Backoff before retry n is random(0..1) * min(maxMs, baseMs * 2^(n-1)). */
  baseMs?: number;
  maxMs?: number;
  /** Per-attempt timeout. No timeout when omitted. */
  timeoutMs?: number;
  label?: string;
  /** False stops retrying: a 400 or a missing file will not fix itself. */
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? realSleep;
  const label = opts.label ?? 'call';
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const run = (signal: AbortSignal) => fn(attempt, signal);
      return opts.timeoutMs
        ? await withTimeout(run, opts.timeoutMs, label)
        : await run(new AbortController().signal);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || (opts.isRetryable && !opts.isRetryable(err))) break;
      // computeBackoffMs counts from 0, so the first retry waits up to baseMs.
      const delay = computeBackoffMs(attempt - 1, {
        baseMs: opts.baseMs ?? 500, maxMs: opts.maxMs ?? 8000, rand: opts.random,
      });
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
