/**
 * Calendar dates as `YYYY-MM-DD` strings, in the business's own timezone.
 *
 * Every date this pipeline stores - first contact, next follow-up, a brief's
 * run date - is a Manila calendar day. `toISOString()` gives the UTC day, which
 * is yesterday in Manila until 08:00, so a morning run would record the wrong
 * contact date and miss follow-ups due that day.
 */

const TIME_ZONE = 'Asia/Manila';

// en-CA formats as YYYY-MM-DD.
const FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** The Manila calendar day an instant falls on. */
export function localDate(at: Date): string {
  return FORMAT.format(at);
}

export function today(): string {
  return localDate(new Date());
}

/** Calendar arithmetic on a date string; UTC here only avoids DST drift. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Whole days from `from` to `to`. Returns 0 rather than NaN for a blank or
 * unparseable date - a lead with a missing timestamp should land on the
 * gentlest step, not crash the run.
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
