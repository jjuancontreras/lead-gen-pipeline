/** Command-line flags for the bin/ scripts: `--flag value` pairs and bare switches. */
export const args = process.argv.slice(2);

/** The value after `flag`, or undefined when the flag is absent. */
export const val = (flag: string, argv: readonly string[] = args): string | undefined =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;

/**
 * A positive whole-number flag, or undefined when absent.
 *
 * `Number('abc')` is NaN and `slice(0, NaN)` is `[]`, so `--max-verify abc`
 * used to verify nothing and report success. A bad value is now an error.
 */
export function optionalIntFlag(flag: string, argv: readonly string[] = args): number | undefined {
  if (!argv.includes(flag)) return undefined;
  const raw = val(flag, argv);
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${flag} must be a positive whole number, got "${raw}"`);
  }
  return Number(raw);
}

/** A positive whole-number flag with a default. */
export const intFlag = (flag: string, fallback: number, argv: readonly string[] = args): number =>
  optionalIntFlag(flag, argv) ?? fallback;

/** Every value that follows a repeatable flag. */
export const multiFlag = (flag: string, argv: readonly string[] = args): string[] =>
  argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
