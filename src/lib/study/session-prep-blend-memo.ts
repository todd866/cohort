/** Background-only memo for owner session-prep blend plans.
 *
 * `peekSessionPrepBlend` is deliberately a read of process memory. It never
 * calls the readiness provider or joins learner history. The caller may use a
 * remembered plan in the request path and schedule `refreshSessionPrepBlend`
 * after the response. The provider supplied to refresh is responsible for the
 * owner-only, bounded brief/calendar/content read.
 */
import { refreshPrepBlendClock, type PrepBlendPlan } from './session-prep-blend';

export const SESSION_PREP_BLEND_MAX_AGE_MS = 30 * 60 * 1000;
export const SESSION_PREP_BLEND_REFRESH_AFTER_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 5_000;

export type SessionPrepBlendProvider = (
  userId: string,
  rotation: string,
  now: Date,
) => Promise<PrepBlendPlan>;

interface Snapshot {
  computedAt: number;
  plan: PrepBlendPlan;
}

const snapshots = new Map<string, Snapshot>();
const inflight = new Map<string, Promise<void>>();
const keyOf = (userId: string, rotation: string) => `${userId}\u0000${rotation}`;

export function rememberSessionPrepBlend(
  userId: string,
  rotation: string,
  plan: PrepBlendPlan,
  now: number = Date.now(),
): void {
  const key = keyOf(userId, rotation);
  snapshots.delete(key);
  snapshots.set(key, { computedAt: now, plan });
  if (snapshots.size > MAX_ENTRIES) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
}

/** Return a fresh/stale remembered plan, or null. Never computes. */
export function peekSessionPrepBlend(
  userId: string,
  rotation: string,
  now: number | Date = Date.now(),
): { plan: PrepBlendPlan; stale: boolean } | null {
  const snapshot = snapshots.get(keyOf(userId, rotation));
  if (!snapshot) return null;
  const at = now instanceof Date ? now.getTime() : now;
  const age = at - snapshot.computedAt;
  if (age < 0 || age > SESSION_PREP_BLEND_MAX_AGE_MS) return null;
  if (snapshot.plan.sessions.length > 0 && snapshot.plan.sessions.every((session) => Date.parse(session.startAt) <= at)) return null;
  const plan = snapshot.plan.sessions.length ? refreshPrepBlendClock(snapshot.plan, new Date(at)) : snapshot.plan;
  return { plan, stale: age > SESSION_PREP_BLEND_REFRESH_AFTER_MS };
}

/** Compute once per owner/rotation; failures never poison or throw into serving. */
export function refreshSessionPrepBlend(
  userId: string,
  rotation: string,
  now: Date = new Date(),
  provider: SessionPrepBlendProvider,
): Promise<void> {
  const key = keyOf(userId, rotation);
  const running = inflight.get(key);
  if (running) return running;
  const job = provider(userId, rotation, now)
    .then((plan) => rememberSessionPrepBlend(userId, rotation, plan, now.getTime()))
    .catch(() => {})
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export function resetSessionPrepBlendMemo(): void {
  snapshots.clear();
  inflight.clear();
}
