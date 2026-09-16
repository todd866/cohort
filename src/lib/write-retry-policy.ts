/**
 * HTTP responses for which replaying the exact same idempotent write is useful.
 *
 * Authentication failures are retained until the user signs back in, 429 is a
 * temporary capacity signal, and server failures may heal. Other 4xx responses
 * are not indefinitely retriable; high-value review writes may still receive a
 * bounded compatibility window in the outbox before the poison entry is
 * reported and dropped.
 */
export function isRetriableWriteStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}
