import { fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';

/**
 * Offline self-report.
 *
 * iOS has no devtools, and an installed PWA gets its own storage container that
 * is invisible from the browser used to install it. Neither the learner nor
 * support tooling can inspect what the device decided — the app has to say.
 *
 * DIAGNOSTIC ONLY. This reports counts and states, never content: no card ids,
 * no card text, no answers, no URLs. It rides LearningEvent with its own
 * eventType rather than a new table, so it is already covered by the privacy
 * inventory, the export flow and account deletion.
 */

export const OFFLINE_TELEMETRY_EVENT = 'offline_telemetry';
export const TELEMETRY_ENDPOINT = '/api/offline/telemetry';

export interface OfflineSnapshot {
  /** Items currently held in the on-device pack. */
  packItems: number;
  /** Age of the pack in whole minutes, or null if there is no pack. */
  packAgeMin: number | null;
  /** How many rotations the pack spans. Count only, never which. */
  packRotations: number;
  /** Entries in the figure cache. */
  figuresCached: number;
  /** What the browser said to navigator.storage.persist(). */
  persistence: string;
  /**
   * 'standalone' means it was installed to the home screen. On iOS this is the
   * single most important field: a bookmark and an installed app behave
   * completely differently, and only the installed one has a usable shell.
   */
  displayMode: string;
  /** Unsent graded answers waiting in the outbox. */
  outboxSize: number;
  /** Whether a service worker is registered and actually controlling the page. */
  swRegistered: boolean;
  swControlling: boolean;
  /** Bytes, from navigator.storage.estimate(). Null when unsupported. */
  storageUsedMb: number | null;
  storageQuotaMb: number | null;
  /** Coarse engine hint. 'webkit' covers every browser on iOS. */
  engine: 'webkit' | 'blink' | 'gecko' | 'unknown';
  /** Set when the last pack fill failed, so a silent failure is still visible. */
  lastError?: string;
}

function engineOf(ua: string): OfflineSnapshot['engine'] {
  // Order matters: every iOS browser reports a Safari/WebKit token, and Chrome
  // on iOS (CriOS) is WebKit underneath despite the name.
  if (/iPhone|iPad|iPod|CriOS|FxiOS/i.test(ua)) return 'webkit';
  if (/Chrome|Chromium|Edg\//i.test(ua)) return 'blink';
  if (/Firefox/i.test(ua)) return 'gecko';
  if (/Safari/i.test(ua)) return 'webkit';
  return 'unknown';
}

export function detectDisplayMode(matcher: (q: string) => boolean, navStandalone?: boolean): string {
  // iOS Safari predates the display-mode media query for installed apps and
  // exposes navigator.standalone instead, so check both.
  if (navStandalone === true) return 'standalone';
  for (const mode of ['standalone', 'fullscreen', 'minimal-ui']) {
    if (matcher(`(display-mode: ${mode})`)) return mode;
  }
  return 'browser';
}

function mb(bytes: number | undefined): number | null {
  return typeof bytes === 'number' ? Math.round((bytes / 1_048_576) * 10) / 10 : null;
}

export interface SnapshotDeps {
  packItems: number;
  packUpdatedAt: number | null;
  packRotations: number;
  figuresCached: number;
  persistence: string;
  outboxSize: number;
  lastError?: string;
  now?: number;
}

/** Pure assembly, so the shape can be tested without a browser. */
export function buildSnapshot(
  deps: SnapshotDeps,
  env: {
    ua: string;
    matchMedia: (q: string) => boolean;
    navStandalone?: boolean;
    swRegistered: boolean;
    swControlling: boolean;
    usage?: number;
    quota?: number;
  },
): OfflineSnapshot {
  const now = deps.now ?? Date.now();
  return {
    packItems: deps.packItems,
    packAgeMin:
      deps.packUpdatedAt === null
        ? null
        : Math.max(0, Math.round((now - deps.packUpdatedAt) / 60_000)),
    packRotations: deps.packRotations,
    figuresCached: deps.figuresCached,
    persistence: deps.persistence,
    displayMode: detectDisplayMode(env.matchMedia, env.navStandalone),
    outboxSize: deps.outboxSize,
    swRegistered: env.swRegistered,
    swControlling: env.swControlling,
    storageUsedMb: mb(env.usage),
    storageQuotaMb: mb(env.quota),
    engine: engineOf(env.ua),
    ...(deps.lastError ? { lastError: deps.lastError.slice(0, 300) } : {}),
  };
}

/**
 * Fire-and-forget. Never throws, never blocks a caller, and is deadline-guarded
 * — a hung report must not wedge the page it is reporting about.
 */
export async function reportOfflineState(snapshot: OfflineSnapshot): Promise<boolean> {
  try {
    const res = await fetchWithDeadline(
      TELEMETRY_ENDPOINT,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot),
        cache: 'no-store',
      },
      CLIENT_FETCH_DEADLINE_MS,
    );
    return res.ok;
  } catch {
    return false;
  }
}
