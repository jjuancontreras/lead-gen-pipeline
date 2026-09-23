/** Command-line flags for the bin/ scripts: `--flag value` pairs and bare switches. */
export const args = process.argv.slice(2);

/** The value after `flag`, or undefined when the flag is absent. */
export const val = (flag: string): string | undefined =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
