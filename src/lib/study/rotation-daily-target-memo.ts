import { computeRotationDailyTarget, type RotationDailyTarget } from './rotation-daily-target';

/**
 * The rotation daily target, for the session request, without waiting for it.
 *
 * computeRotationDailyTarget reads every servable card in the rotation, progress
 * counts and 14 days of history. Against production on 3 Oct 2026 it took
 * 1.1-4.8 s, and it ran inline in the session request's "auth" phase: in the
 * slowest loads that phase had a median of 2-6.5 s while identity itself took
 * ~45 ms. History belongs off the request path (.claude/rules/hot-path-latency.md).
 *
 * The request reads a snapshot remembered by this instance. A missing snapshot
 * means "serve without the adaptive target"; the caller then computes one after
 * the response. Background builds that compute the target anyway remember it
 * here too. The target is per study day, so a few minutes' staleness changes
 * nothing that matters, and a snapshot is refreshed in the background once it is
 * REFRESH_AFTER_MS old.
 */

/** A snapshot older than this is not served at all. */
export const MAX_AGE_MS = 30 * 60 * 1000;
/** A snapshot older than this is served, and refreshed after the response. */
export const REFRESH_AFTER_MS = 2 * 60 * 1000;
/** Instances are short-lived; this only bounds a pathological one. */
const MAX_ENTRIES = 5_000;

interface Snapshot {
  studyDayMs: number;
  computedAt: number;
  target: RotationDailyTarget;
}

const snapshots = new Map<string, Snapshot>();
const inflight = new Map<string, Promise<void>>();
const keyOf = (userId: string, rotation: string) => `${userId}\u0000${rotation}`;

export function rememberRotationDailyTarget(
  userId: string,
  rotation: string,
  studyDayStart: Date,
  target: RotationDailyTarget,
  now: number = Date.now(),
): void {
  const key = keyOf(userId, rotation);
  snapshots.delete(key);
  snapshots.set(key, { studyDayMs: studyDayStart.getTime(), computedAt: now, target });
  if (snapshots.size > MAX_ENTRIES) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
}

/** Today's remembered target, or null. Never computes. */
export function peekRotationDailyTarget(
  userId: string,
  rotation: string,
  studyDayStart: Date,
  now: number = Date.now(),
): { target: RotationDailyTarget; stale: boolean } | null {
  const snapshot = snapshots.get(keyOf(userId, rotation));
  if (!snapshot || snapshot.studyDayMs !== studyDayStart.getTime()) return null;
  const age = now - snapshot.computedAt;
  if (age > MAX_AGE_MS) return null;
  return { target: snapshot.target, stale: age > REFRESH_AFTER_MS };
}

/**
 * Compute and remember, once per learner and rotation at a time. For after()
 * and background builds only: it never throws, and a failure remembers nothing.
 */
export function refreshRotationDailyTarget(
  userId: string,
  rotation: string,
  studyDayStart: Date,
  now: Date = new Date(),
  compute: typeof computeRotationDailyTarget = computeRotationDailyTarget,
): Promise<void> {
  const key = keyOf(userId, rotation);
  const running = inflight.get(key);
  if (running) return running;
  const job = compute(userId, rotation, studyDayStart, now)
    .then((target) => rememberRotationDailyTarget(userId, rotation, studyDayStart, target))
    .catch(() => {})
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export function resetRotationDailyTargetMemo(): void {
  snapshots.clear();
  inflight.clear();
}
