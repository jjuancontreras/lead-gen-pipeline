/**
 * The repo root: the nearest directory above this file holding package.json.
 *
 * "One directory up from this file" held for `src/x.ts` under tsx and broke for
 * `dist/src/x.js` after a build, where config/ and templates/ are two levels
 * up. Walking to package.json is right in both layouts.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findPackageRoot(start: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No package.json above ${start}`);
    dir = parent;
  }
}
