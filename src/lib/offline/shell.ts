/**
 * Warming the offline shell.
 *
 * The service worker caches `/_next/static/` lazily — an asset is only stored
 * once the browser has asked for it. That is fine for the routes you have
 * already visited, but the `/offline` route is by definition one you never visit
 * while online, so its document and its page chunk would never be cached and the
 * fallback would be an empty screen exactly when it is needed.
 *
 * So the app warms it explicitly: fetch `/offline`, read the build asset URLs out
 * of the returned HTML, and hand both to the worker to store. The parsing lives
 * here, in testable TypeScript, rather than in sw.js — the worker only ever does
 * dumb `cache.put`.
 */
import { fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';
import { OFFLINE_SHELL_WINDOW_KEY } from '@/lib/review/session-preload';

/** Fixed name; the shell is re-warmed on each app open rather than versioned. */
export const SHELL_CACHE = 'md3-shell-v1';

export const OFFLINE_ROUTE = '/offline';

/** A page referencing more than this is not a Next build output we recognise. */
const MAX_PRECACHE_URLS = 200;

const ASSET_ATTR = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;

/**
 * Mark only the cached fallback copy before any of its ordinary head scripts
 * execute. In particular this stops the global review-session preload from
 * issuing a personalized API request when this credentialless document is
 * substituted for `/`, `/profile`, or another failed navigation.
 */
export function markOfflineShellDocument(html: string): string | null {
  const head = HEAD_OPEN.exec(html);
  if (!head || head.index === undefined) return null;
  const insertionAt = head.index + head[0].length;
  const marker = `<script>window.${OFFLINE_SHELL_WINDOW_KEY}=true;</script>`;
  return `${html.slice(0, insertionAt)}${marker}${html.slice(insertionAt)}`;
}

/**
 * Same-origin, immutable build assets only. Cross-origin scripts, signed media
 * URLs and API routes must never enter a shared cache — that conflation is what
 * made sw.js v1 a privacy problem.
 */
export function extractPrecacheUrls(html: string): string[] {
  const found = new Set<string>();
  const base = new URL(
    '/',
    typeof location === 'undefined' ? 'https://md3.invalid' : location.origin,
  );
  for (const match of html.matchAll(ASSET_ATTR)) {
    let parsed: URL;
    try {
      parsed = new URL(match[1], base);
    } catch {
      continue;
    }
    if (parsed.origin !== base.origin) continue;
    if (!parsed.pathname.startsWith('/_next/static/')) continue;
    const url = `${parsed.pathname}${parsed.search}`;
    found.add(url);
    if (found.size >= MAX_PRECACHE_URLS) break;
  }
  return [...found];
}

/**
 * Whether the offline page should present itself as offline.
 *
 * `navigator.onLine` alone is not trustworthy: it reports the network interface,
 * not reachability, and in testing it stayed `true` on a document that had just
 * been served by the fallback. The stronger signal is the URL — if this page is
 * rendering at any path other than /offline, it is only here because the service
 * worker substituted it for a navigation that failed.
 */
export function isServedAsOfflineFallback(pathname: string, onLine: boolean): boolean {
  if (pathname !== OFFLINE_ROUTE) return true;
  return !onLine;
}

/**
 * How many times a shell-rendered tab may try to pull the real app down before
 * giving up. Bounded so a network that answers `navigator.onLine === true` but
 * black-holes requests (captive/hospital Wi-Fi) cannot produce a reload loop.
 */
export const SHELL_RECOVERY_MAX_ATTEMPTS = 3;

/**
 * Deadline for the recovery reachability probe. Short: this only has to answer
 * "is the network actually back?", and an unbounded fetch would defeat the whole
 * mechanism — a probe that never settles never retries, leaving the tab stuck in
 * the shell forever, which is precisely the failure being repaired.
 */
export const SHELL_RECOVERY_PROBE_DEADLINE_MS = 5_000;

/**
 * Wait before the FIRST recovery probe.
 *
 * The probe must not fire synchronously on mount. The shell is often rendered
 * for a transient failure (a 502, a momentary hang) with the network otherwise
 * healthy, so an immediate probe succeeds and reloads the instant the shell
 * paints — yanking the page out from under whatever navigation is already in
 * flight. In CI that surfaced as `page.reload: net::ERR_ABORTED; maybe frame was
 * detached?`, our reload racing the test's; for a user it is a flash-reload they
 * did not ask for.
 *
 * A short delay costs nothing against a tab that would otherwise stay stuck
 * indefinitely. The `online` EVENT still probes immediately — that is a real
 * connectivity transition, not a cold guess.
 */
export const SHELL_RECOVERY_INITIAL_DELAY_MS = 3_000;

/**
 * Should a tab currently rendering the offline shell try to get the real app?
 *
 * The service worker answers a failed navigation to `/` with the cached
 * `/offline` document, so the URL stays `/` while the shell renders. Nothing
 * then pulled the live app back down when connectivity returned: the `online`
 * listener updates state, but `isServedAsOfflineFallback` ignores it for any
 * path other than `/offline`, so the tab stayed in offline mode indefinitely —
 * serving the device pack, with a progress pill that shows a bare count and no
 * daily target because `useSessionProgress` is disabled in that mode.
 *
 * A deliberate visit to `/offline` is left alone; the user asked for it.
 */
export function shouldAttemptShellRecovery(input: {
  active: boolean;
  pathname: string;
  online: boolean;
  attempts: number;
}): boolean {
  const { active, pathname, online, attempts } = input;
  if (!active || !online) return false;
  if (pathname === OFFLINE_ROUTE) return false;
  return attempts < SHELL_RECOVERY_MAX_ATTEMPTS;
}

function alreadyWarmedThisSession(): boolean {
  try {
    return sessionStorage.getItem('md3:shell-warmed') === '1';
  } catch {
    return false;
  }
}

function markWarmed(): void {
  try {
    sessionStorage.setItem('md3:shell-warmed', '1');
  } catch {
    // Private mode — warming again next load is harmless.
  }
}

/**
 * Fetch and cache the offline shell. Runs once per tab session so a deploy that
 * changes the chunk hashes cannot leave a shell pointing at assets that no
 * longer exist; the cost is one small document fetch per app open.
 */
export async function warmOfflineShell(): Promise<boolean> {
  if (typeof caches === 'undefined' || typeof fetch === 'undefined') return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;

  try {
    const cache = await caches.open(SHELL_CACHE);

    // The session flag alone is not enough to skip. Storage pressure can evict
    // the cache mid-session, and a tab that has already warmed would then never
    // warm again — leaving no fallback at all. Presence of the document is the
    // condition that actually matters; the flag only stops us re-fetching it on
    // every route change.
    const cached = await cache.match(OFFLINE_ROUTE);
    if (cached && alreadyWarmedThisSession()) return false;

    const response = await fetchWithDeadline(
      OFFLINE_ROUTE,
      { credentials: 'omit' },
      CLIENT_FETCH_DEADLINE_MS,
    );
    if (!response.ok || response.redirected) return false;

    const html = await response.clone().text();
    const contentType = response.headers?.get?.('content-type');
    if (contentType && !contentType.toLowerCase().includes('text/html')) return false;
    if (!html.includes('data-md3-offline-shell')) return false;
    const cachedHtml = markOfflineShellDocument(html);
    if (!cachedHtml) return false;

    // `fetch()` exposes decompressed bytes. Remove representation metadata
    // before constructing a new response around the marked HTML.
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.delete('etag');
    headers.set('content-type', 'text/html; charset=utf-8');
    await cache.put(OFFLINE_ROUTE, new Response(cachedHtml, {
      status: response.status || 200,
      statusText: response.statusText,
      headers,
    }));

    const assets = extractPrecacheUrls(html);
    // Individually, so one 404 cannot fail the whole warm.
    await Promise.all(
      assets.map(async (url) => {
        try {
          const asset = await fetchWithDeadline(
            url,
            { credentials: 'omit', cache: 'force-cache' },
            CLIENT_FETCH_DEADLINE_MS,
          );
          if (asset.ok && !asset.redirected) await cache.put(url, asset);
        } catch {
          // Asset unavailable — the shell degrades, it does not break.
        }
      }),
    );


    markWarmed();
    return true;
  } catch {
    return false;
  }
}
