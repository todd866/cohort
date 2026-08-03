/**
 * Generate a stable per-request idempotency key for a write.
 *
 * Generated ONCE at the moment of the action and carried in the request body, so
 * it survives every replay vector unchanged: submitWithRetry re-sends the same
 * body, and the outbox persists + replays the same body. The server
 * (src/lib/idempotency.ts) dedups on (userId, clientRequestId) so a grade/answer
 * is applied at most once. Mirrors the flag path's existing id.
 */
export function genClientRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
