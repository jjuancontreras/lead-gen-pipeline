/**
 * One background job at a time, for the console.
 *
 * A recording, a harvest or an automatic verify run takes minutes and drives
 * a browser. The console starts it, answers at once, and the page polls
 * `status()`. A second request while one runs is refused, not queued.
 */
import { errorMessage } from './errors.ts';

export interface JobStatus {
  running: boolean;
  label?: string;
  startedAt?: string;
  /** The last job's error, until the next job starts. */
  lastError?: string;
  /** What the last job finished, until the next job starts. */
  lastResult?: string;
}

export class SingleJob {
  private current: JobStatus = { running: false };

  status(): JobStatus {
    return { ...this.current };
  }

  /** Start `fn` in the background. False if a job is already running. */
  start(label: string, fn: () => Promise<string | void>): boolean {
    if (this.current.running) return false;
    this.current = { running: true, label, startedAt: new Date().toISOString() };
    void fn().then(
      (result) => { this.current = { running: false, ...(result ? { lastResult: result } : {}) }; },
      (err: unknown) => { this.current = { running: false, lastError: errorMessage(err) }; },
    );
    return true;
  }
}
