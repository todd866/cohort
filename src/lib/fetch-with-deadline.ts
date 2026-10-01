/**
 * A `fetch` that is guaranteed to settle.
 *
 * An `await fetch(...)` with no abort signal can hang forever. On 2026-07-09
 * that wedged `flushOutbox`, and because the review feed was gated behind the
 * flush, the installed PWA/mobile web UI sat on "Preparing review…" indefinitely. The same shape
 * exists anywhere a request is awaited in a loop.
 *
 * We both abort AND race a deadline: `signal` is the polite path, but the race
 * is what guarantees the caller advances even if the request never honours the
 * abort (a wedged service-worker fetch handler, say). `AbortController` rather
 * than `AbortSignal.timeout` — the latter is Safari 16+ and is not controllable
 * by fake timers in tests.
 */
export const CLIENT_FETCH_DEADLINE_MS = 15_000;
export const STUDY_SESSION_FETCH_DEADLINE_MS = 35_000;
/**
 * The offline pack asks the scheduler for up to 1,000 items in one build, not
 * the ~15 a review page needs, and for a heavy account that build runs 40-140s.
 * Measured 2026-09-17: at the 35s review deadline the client abandoned every
 * pack request while the server carried on to its own ceiling and returned
 * 504 (91 timeouts against 39 successes in three hours). Nothing landed, so
 * each grade re-armed another full build; the route became the largest CPU
 * consumer on the project and starved the connection pool for every other
 * route. This must outlast the build and stay under the route's 300s ceiling.
 */
export const OFFLINE_PACK_FETCH_DEADLINE_MS = 240_000;
/**
 * Review can safely start from its persisted browser preferences if this
 * lightweight account snapshot is unavailable. Keep this much shorter than a
 * study-session request: it gates the request rather than delivering content.
 */
export const REVIEW_CONTEXT_FETCH_DEADLINE_MS = 2_000;

export async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeoutError = new Error(`fetch timed out after ${ms}ms: ${url}`);
      // Reject the race first so callers consistently receive the descriptive
      // deadline error, while fetch still receives an abort immediately after.
      reject(timeoutError);
      controller.abort(timeoutError);
    }, ms);
  });
  try {
    return await Promise.race([fetch(url, { ...init, signal: controller.signal }), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}
