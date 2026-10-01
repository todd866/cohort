// public/sw.js
// build: __BUILD_STAMP__

// Cache only immutable, same-origin build assets. Previous service-worker
// versions cached personalized session JSON, navigations, and arbitrary
// subresources by URL; that could retain one user's data or short-lived signed
// media URLs across logout/account changes. The version bump purges those
// legacy caches during activation.
//
// v3 adds an offline fallback for navigations, without relaxing any of that.
// Navigations are network-first with NO write-back — a rendered page is
// personalized, so it is served and forgotten. The only document ever stored is
// /offline, a static client page that renders from the device's own user-keyed
// pack (src/lib/offline/pack.ts), which is wiped on sign-out.
//
// CACHE_NAME stays at v2 deliberately: the stored assets are content-hashed and
// still valid, so renaming would force every user to re-download them for no
// behavioural gain.
const CACHE_NAME = 'md3-static-v2';
// SHELL_CACHE IS BUILD-STAMPED, unlike CACHE_NAME above, and the difference is
// the whole point. CACHE_NAME holds content-hashed assets that stay valid
// forever. This holds the OFFLINE SHELL — a rendered document whose client
// router only knows the routes that existed when it was cached.
//
// It was 'md3-shell-v1', a fixed name, so a shell cached months ago survived
// every deploy. `networkThenShell` serves it whenever a navigation fetch times
// out, which on a slow connection is often. A learner then gets an old shell,
// its router does not recognise a route added since, and the app renders "Page
// not found" for a page that is live and returning 200 — reported 2026-09-14 by
// a user who could not open /content while the route was healthy for everyone
// else. Slow network in, hard 404 out.
//
// Stamping the name means activate() prunes the previous build's shell via
// KEEP_CACHES, so the fallback can never be older than the running build.
const SHELL_CACHE = 'md3-shell-__BUILD_STAMP__';
// Figure bytes are written explicitly by src/lib/offline/figures.ts after an
// authenticated entitlement check. Worker activation must not erase them;
// account lifecycle code owns their deletion.
const FIGURE_CACHE = 'md3-figures-v1';
const OFFLINE_ROUTE = '/offline';
const KEEP_CACHES = [CACHE_NAME, SHELL_CACHE, FIGURE_CACHE];
// Shorter than Navigation's 15-second pending-intent window. A connected
// network interface can still black-hole requests (common on captive/hospital
// Wi-Fi), so raw fetch rejection is not a sufficient offline signal.
const NAVIGATION_NETWORK_DEADLINE_MS = 10_000;
const TRANSIENT_GATEWAY_STATUSES = [502, 503, 504];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => !KEEP_CACHES.includes(key)).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkThenShell(request));
    return;
  }

  // Next client navigations fetch an RSC payload rather than a document. Keep
  // those requests network-only, but tell the initiating page when one failed
  // so it can opt into the already-cached offline shell. The worker reports
  // only; it never chooses a route, fabricates an RSC response, or caches one.
  if (request.headers.get('RSC') === '1' || url.searchParams.has('_rsc')) {
    event.respondWith(networkThenReportRscFailure(
      request,
      url.pathname,
      event.clientId,
    ));
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request));
  }
});

async function cacheFirst(request) {
  // caches.match searches every cache, so assets stored by the offline-shell
  // warm (src/lib/offline/shell.ts) are served from here too.
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkThenReportRscFailure(request, path, clientId) {
  try {
    return await fetchNavigationNetwork(request);
  } catch (err) {
    if (clientId) {
      try {
        const client = await self.clients.get(clientId);
        client?.postMessage({ type: 'md3-rsc-navigation-failed', path });
      } catch {
        // Reporting is best-effort; preserve the original network rejection.
      }
    }
    throw err;
  }
}

async function networkThenShell(request) {
  try {
    return await fetchNavigationNetwork(request);
  } catch (err) {
    const shell = await caches.match(OFFLINE_ROUTE);
    if (shell) return shell;
    throw err;
  }
}

async function fetchNavigationNetwork(request) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    NAVIGATION_NETWORK_DEADLINE_MS,
  );
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (TRANSIENT_GATEWAY_STATUSES.includes(response.status)) {
      throw new Error(`Transient gateway response: ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
