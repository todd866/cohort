/**
 * Practice locale — coarse AU vs US exam/practice split for discrepancy twins.
 *
 * Distinct from protocol `jurisdiction` (nsw/wa/national). Null on a card means
 * universal (no split). Default user locale is AU unless specifically studying
 * USMLE (institution or usmle-* session rotation/focus).
 */

export type PracticeLocale = 'au' | 'us';

export interface ResolvePracticeLocaleInput {
  institution?: string | null;
  /** Primary request rotation (current objective). */
  requestRotation?: string | null;
  /** Explicit focus mode (URL focus). */
  focus?: boolean;
  /** Rotation when focus=true; otherwise ignored for locale. */
  focusRotation?: string | null;
  /** Ignored for locale — dessert opt-ins must not flip AU→US. */
  activeModules?: readonly string[] | null;
}

function isUsmleRotation(rotation?: string | null): boolean {
  return typeof rotation === 'string' && /^usmle-/i.test(rotation);
}

export function resolvePracticeLocale(input: ResolvePracticeLocaleInput): PracticeLocale {
  if (input.institution === 'usmle') return 'us';
  if (isUsmleRotation(input.requestRotation)) return 'us';
  if (input.focus && isUsmleRotation(input.focusRotation)) return 'us';
  return 'au';
}

/** Prisma-friendly OR clause: universal (null) or matching locale. */
export function practiceLocaleWhere(locale: PracticeLocale): {
  OR: Array<{ practiceLocale: string | null }>;
} {
  return {
    OR: [{ practiceLocale: null }, { practiceLocale: locale }],
  };
}
