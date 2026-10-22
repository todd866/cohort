/**
 * The institution a learner is read as, when the stored value is missing.
 *
 * Most Year 3 learners chose a stream (track) without ever being asked for an
 * institution, so `User.institution` is null for a large share of them, and
 * every gate keyed to `'usyd'` failed closed on people who are plainly USyd
 * students. Owner direction, 2026-10-22: "If someone's reviewing USyd content
 * it's a fair guess they're USyd."
 *
 * The rule, in order:
 *   1. An explicit institution is authoritative and never overridden.
 *   2. Guests are never inferred: an anonymous browser is not a student.
 *   3. A registered learner with a Year 3 stream (track 1-4) is usyd.
 *   4. A registered learner most of whose recent answers are in the four Year 3
 *      block rotations is usyd. Only callers that already hold those counts
 *      (the backfill, the daily audit) pass them: counting history is not a
 *      request-path read (.claude/rules/hot-path-latency.md).
 *
 * Pure and dependency-free: the session payload, the clinical guide gate, the
 * minimal user read and the institution backfill all use this one function.
 */

export const USYD_BLOCK_ROTATIONS: ReadonlySet<string> = new Set(['cah', 'pwh', 'paam', 'critical-care']);

export interface InstitutionEvidence {
  institution: string | null | undefined;
  track: number | null | undefined;
  /** False for a guest identity. */
  registered: boolean;
  /** Answers per rotation over a recent window, when the caller has them. */
  recentRotationCounts?: Readonly<Record<string, number>>;
}

export function isUsydTrack(track: number | null | undefined): boolean {
  return Number.isInteger(track) && (track as number) >= 1 && (track as number) <= 4;
}

/** Strictly more than half of the counted answers are in the Year 3 block rotations. */
export function isUsydActivityMajority(counts: Readonly<Record<string, number>>): boolean {
  let usyd = 0;
  let total = 0;
  for (const [rotation, n] of Object.entries(counts)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    total += n;
    if (USYD_BLOCK_ROTATIONS.has(rotation)) usyd += n;
  }
  return total > 0 && usyd * 2 > total;
}

export function effectiveInstitution(evidence: InstitutionEvidence): string | null {
  const explicit = evidence.institution?.trim();
  if (explicit) return explicit;
  if (!evidence.registered) return null;
  if (isUsydTrack(evidence.track)) return 'usyd';
  if (evidence.recentRotationCounts && isUsydActivityMajority(evidence.recentRotationCounts)) return 'usyd';
  return null;
}
