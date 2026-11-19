import { reportClientError } from './report-client-error';

export const CLIENT_IDENTITY_WAIT_MS = 4_000;

/** Per-tab startup barrier. The root provider starts it before children mount.
 * Standalone consumers (including Cohort) need no MD3 session barrier. */
let pending: Promise<void> | null = null;
let release: (() => void) | null = null;
let deadline: ReturnType<typeof setTimeout> | undefined;

export function beginClientIdentityResolution(): void {
  if (pending) return;
  pending = new Promise<void>((resolve) => { release = resolve; });
  deadline = setTimeout(() => {
    // Fail open into the existing request/auth recovery path. Releasing the
    // shared barrier also avoids another wait for each queued grade.
    resolveClientIdentity();
    reportClientError(new Error(`identity-wait-deadline after ${CLIENT_IDENTITY_WAIT_MS}ms`), 'client-identity');
  }, CLIENT_IDENTITY_WAIT_MS);
}

export function resolveClientIdentity(): void {
  clearTimeout(deadline);
  deadline = undefined;
  release?.();
  pending = null;
  release = null;
}

export function waitForClientIdentity(signal?: AbortSignal | null): Promise<void> | null {
  if (!pending) return null;
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    void pending!.then(() => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) abort();
      else resolve();
    });
  });
}
