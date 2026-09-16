/**
 * Idempotency key for one logical session request.
 *
 * `/api/study/unified-session` is a GET that MINTS a delivery: it writes
 * ServeDecisions and content-exposure events as a side effect. It used to
 * generate its own session id per request, so an automatic retry after a
 * timeout arrived as a brand-new session and delivered the same batch a second
 * time — inserting child ServeDecision rows instead of updating the first
 * delivery in place. Under a slow-cache stall the client retried 3-4 times and
 * every attempt counted as another serve, which is how one card reached 18
 * exposures in ten weeks.
 *
 * The client now generates one id per logical fetch and reuses it across
 * retries, so the existing same-session branch in `serve-decision-write.ts`
 * updates the delivery in place. This mirrors the `serveRequestId` the Cohort
 * answer path already uses.
 *
 * The value is client-supplied, so it is validated as a UUID before use. It can
 * only ever affect the caller's own rows: the parent ServeDecision is looked up
 * from the items in that user's own cached queue.
 */
import { randomUUID } from 'crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isServeRequestId(value: string): boolean {
  return UUID.test(value);
}

/** The client's key when it is a real UUID, otherwise a fresh one. */
export function resolveServeRequestId(param: string | null | undefined): string {
  const trimmed = param?.trim() ?? '';
  return isServeRequestId(trimmed) ? trimmed.toLowerCase() : randomUUID();
}
