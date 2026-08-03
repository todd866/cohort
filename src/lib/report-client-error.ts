/**
 * Beacon a client-side error to /api/log/client-error so production crashes
 * caught by React error boundaries are visible in Vercel function logs instead
 * of dying silently on the user's device (md3 is mobile-first and has no
 * Sentry/error-tracking — see the client-error route + flag-submit beacon).
 *
 * Defensive by construction: it must NEVER throw, because it runs inside the
 * error boundaries (global-error.tsx / error.tsx) where a throw would replace
 * one crash with another.
 */
export function reportClientError(
  error: Error & { digest?: string },
  source: string,
): void {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      return;
    }
    const digest = error?.digest ? ` (digest: ${error.digest})` : '';
    navigator.sendBeacon(
      '/api/log/client-error',
      JSON.stringify({
        // Keep enough route context to diagnose the crash without copying
        // query parameters or fragments (which can contain tokens, search
        // terms, document identifiers, or other user-provided data) into logs.
        url: typeof window !== 'undefined'
          ? `${window.location?.origin}${window.location?.pathname}`
          : undefined,
        error: `${source}: ${error?.message ?? 'unknown error'}${digest}`,
        ua: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        ts: Date.now(),
      }),
    );
  } catch {
    /* never let error reporting throw inside an error boundary */
  }
}
