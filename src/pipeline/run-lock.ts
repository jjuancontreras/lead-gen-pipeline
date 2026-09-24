/**
 * One pipeline run at a time per data directory, across processes.
 *
 * The CLI and the console are separate processes over the same state file
 * and lead store, and both do read-modify-write. Two runs at once would each
 * drop the other's updates. The console's SingleJob only covers its own
 * process; this covers the machine.
 *
 * The lock file holds the owner's pid. A lock whose process is gone (a
 * crashed run) is stale and taken over, so a crash never needs a manual
 * cleanup.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class RunLockHeld extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunLockHeld';
  }
}

export interface RunLock {
  release(): void;
}

/** Signal 0 checks that a process exists without touching it. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just is not ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function holderOf(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function acquireRunLock(
  path: string,
  opts: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): RunLock {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  mkdirSync(dirname(path), { recursive: true });

  // Two tries: the second follows clearing a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(pid), { flag: 'wx' });
      return {
        release: () => {
          if (holderOf(path) === pid) rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = holderOf(path);
      if (holder !== null && holder !== pid && isAlive(holder)) {
        throw new RunLockHeld(`another pipeline run is in progress (pid ${holder}, lock ${path})`);
      }
      rmSync(path, { force: true });
    }
  }
  throw new RunLockHeld(`could not take the pipeline lock at ${path}`);
}
