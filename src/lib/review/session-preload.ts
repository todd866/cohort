/**
 * Legacy review-session preload cleanup.
 *
 * Older builds remembered a `/api/study/unified-session` URL and fetched it
 * from an inline <head> script before React hydrated. That endpoint records
 * ServeDecision and exposure rows as part of delivery, so a preload that React
 * later rejected still mutated scheduler history.
 *
 * Keep this tiny bootstrap for one migration window only: it removes the
 * remembered URL and any in-memory handle without making a network request.
 * The live review hook now owns the first (and only) delivery request.
 */

export const SESSION_PRELOAD_STORAGE_KEY = 'md3:session-preload-url';
const LEGACY_WINDOW_KEY = '__md3SessionPreload';

/** Set only inside the credentialless document stored as the navigation fallback. */
export const OFFLINE_SHELL_WINDOW_KEY = '__md3OfflineShell';

/**
 * Inline migration script used by RootLayout.
 *
 * Deliberately contains no `fetch`: evaluating stale preload state must be
 * observationally inert at the API/database boundary.
 */
export function sessionPreloadBootstrap(): string {
  return `(function(){try{
localStorage.removeItem(${JSON.stringify(SESSION_PRELOAD_STORAGE_KEY)});
delete window.${LEGACY_WINDOW_KEY};
}catch(e){}})();`;
}
