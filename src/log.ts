/**
 * Structured logging.
 *
 * `LOG_FORMAT=json` writes one JSON object per line for machines. `pretty`
 * (the default) writes the same record as one readable line. Fields travel
 * with a child logger, so every line from the video stage for one lead says
 * so without each call repeating it.
 */
import { settings } from './settings.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Readonly<Record<string, unknown>>;

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

export interface LoggerOptions {
  format: 'json' | 'pretty';
  level: Level;
  sink?: (line: string) => void;
  clock?: () => Date;
  base?: Fields;
}

const plain = (v: unknown): unknown => (v instanceof Error ? v.message : v);

function prettyLine(ts: Date, level: Level, msg: string, fields: Fields): string {
  const { stage, lead, ...rest } = fields;
  const time = ts.toISOString().slice(11, 19);
  const head = [
    time,
    level.padEnd(5),
    stage ? `[${String(stage)}]` : '',
    lead ? String(lead) : '',
    msg,
  ].filter(Boolean).join(' ');
  const tail = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(plain(v))}`)
    .join(' ');
  return tail ? `${head}  ${tail}` : head;
}

export function createLogger(opts: LoggerOptions): Logger {
  const sink = opts.sink ?? ((line) => process.stderr.write(line + '\n'));
  const clock = opts.clock ?? (() => new Date());
  const base = opts.base ?? {};

  const emit = (level: Level, msg: string, fields: Fields = {}) => {
    if (RANK[level] < RANK[opts.level]) return;
    const all = Object.fromEntries(
      Object.entries({ ...base, ...fields }).map(([k, v]) => [k, plain(v)]),
    );
    const ts = clock();
    sink(opts.format === 'json'
      ? JSON.stringify({ ts: ts.toISOString(), level, msg, ...all })
      : prettyLine(ts, level, msg, all));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

/** The process logger, configured from LOG_FORMAT and LOG_LEVEL. */
export function rootLogger(sink?: (line: string) => void): Logger {
  const s = settings();
  return createLogger({ format: s.logFormat, level: s.logLevel, sink });
}
