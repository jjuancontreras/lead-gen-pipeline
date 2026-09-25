/** One line a person can act on, from any thrown value. */
import { ZodError } from 'zod';

export function errorMessage(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}
