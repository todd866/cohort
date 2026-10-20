/**
 * How long this device was offline since the last telemetry report.
 *
 * Telemetry is itself a request, so an offline stretch used to show up only as
 * silence, which made an unreliable offline mode impossible to diagnose
 * (reported 12 Oct 2026). The browser's offline/online events are logged
 * here and the totals ride the next snapshot that gets through. Counts and
 * durations only.
 */
const KEY = 'md3:connectivity-log';

interface Log { offlineSince: number | null; episodes: number; offlineMs: number; longestMs: number }

function read(storage: Storage): Log {
  try {
    const parsed = JSON.parse(storage.getItem(KEY) ?? 'null') as Partial<Log> | null;
    return {
      offlineSince: typeof parsed?.offlineSince === 'number' ? parsed.offlineSince : null,
      episodes: Number(parsed?.episodes) || 0,
      offlineMs: Number(parsed?.offlineMs) || 0,
      longestMs: Number(parsed?.longestMs) || 0,
    };
  } catch {
    return { offlineSince: null, episodes: 0, offlineMs: 0, longestMs: 0 };
  }
}

function write(storage: Storage, log: Log): void {
  try { storage.setItem(KEY, JSON.stringify(log)); } catch { /* storage full or blocked */ }
}

export function recordOffline(now: number, storage: Storage = localStorage): void {
  const log = read(storage);
  if (log.offlineSince === null) write(storage, { ...log, offlineSince: now });
}

export function recordOnline(now: number, storage: Storage = localStorage): void {
  const log = read(storage);
  if (log.offlineSince === null) return;
  const span = Math.max(0, now - log.offlineSince);
  write(storage, {
    offlineSince: null,
    episodes: log.episodes + 1,
    offlineMs: log.offlineMs + span,
    longestMs: Math.max(log.longestMs, span),
  });
}

/** Totals for completed episodes since the last take, then reset them. */
export function takeConnectivityLog(storage: Storage = localStorage): { offlineEpisodes: number; offlineSec: number; longestOfflineSec: number } {
  const log = read(storage);
  write(storage, { offlineSince: log.offlineSince, episodes: 0, offlineMs: 0, longestMs: 0 });
  return {
    offlineEpisodes: log.episodes,
    offlineSec: Math.round(log.offlineMs / 1000),
    longestOfflineSec: Math.round(log.longestMs / 1000),
  };
}
