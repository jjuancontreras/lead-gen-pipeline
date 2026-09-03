/**
 * The follow-up cadence, as arithmetic on dates rather than hidden state.
 *
 * The sequence is 3 / 7 / 14 days measured from FIRST contact, so every step
 * is derivable from `first_contacted_at` alone. That matters: the Lead record
 * has no column saying which template was last used, and adding one would
 * change the shape of the live Google Sheet. Deriving instead of storing
 * keeps the schema still and makes both rules - "which step is due" and
 * "when is the next one" - pure functions with tests.
 */

/** Day of the sequence, counted from first contact, and what to send on it. */
export const CADENCE: readonly { readonly day: number; readonly template: string }[] = [
  { day: 3, template: 'follow-up-3' },
  { day: 7, template: 'follow-up-7' },
  { day: 14, template: 'breakup-14' },
];

/** The last step: after it there is nothing left to send. */
export const FINAL_TEMPLATE = CADENCE[CADENCE.length - 1]!.template;

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

/**
 * Which step is due today for a lead first contacted on `firstContactedAt`.
 *
 * Never returns null: this is only asked about a lead the pool already found
 * due, and an unknown or future start date means "we are early in the
 * sequence", which is the first follow-up.
 */
export function followUpTemplateFor(firstContactedAt: string, today: string): string {
  const d = daysBetween(firstContactedAt, today);
  let step = CADENCE[0]!.template;
  for (const c of CADENCE) if (d >= c.day) step = c.template;
  return step;
}

/**
 * The date the next touch is due, given when first contact happened and when
 * this one actually went out. `''` means the sequence is finished - the
 * breakup has been sent and there is nothing to schedule.
 */
export function nextActionAfter(firstContactedAt: string, sentOn: string): string {
  const start = firstContactedAt || sentOn;
  const d = daysBetween(start, sentOn);
  const next = CADENCE.find((c) => c.day > d);
  return next ? addDays(start, next.day) : '';
}
