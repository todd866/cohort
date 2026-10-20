/**
 * Link state from what requests actually do, not from `navigator.onLine`.
 *
 * Reported 15 Oct 2026: offline mode worked in airplane mode and crashed on a
 * weak link. `navigator.onLine` stays true on a lossy, very slow or
 * black-holed connection (hospital Wi-Fi, one bar of signal), so the review
 * kept waiting on the network instead of serving the saved pack. A request
 * that fails in transport or runs past its deadline now marks the link
 * `degraded`; the review falls back to the same saved-pack path airplane mode
 * uses, grades stay in the outbox, and a slow background probe returns the
 * state to `online` once a request gets through.
 *
 *   online --failure--> degraded --2 successes or 1 probe--> online
 *   any --browser offline--> offline --browser online--> online
 *
 * The probe backs off to one tiny HEAD a minute and runs only while the page
 * is visible: a client deadline must never become a re-request loop (see the
 * offline-pack 504 incident in fetch-with-deadline.ts).
 */
import { fetchWithDeadline } from '@/lib/fetch-with-deadline';
import { isTransportFailure } from './transport-failure';

export type LinkState = 'online' | 'degraded' | 'offline';

export interface LinkModel {
  state: LinkState;
  browserOnline: boolean;
  successStreak: number;
  lastFailureAt: number | null;
}

export type LinkEvent =
  | { type: 'browser-offline' }
  | { type: 'browser-online' }
  | { type: 'failure'; at: number }
  | { type: 'success'; probe?: boolean };

/** Passive successes needed to leave `degraded`, so a lossy link does not flicker. */
export const RECOVERY_SUCCESS_STREAK = 2;
/** Delay before each background probe while degraded; the last value repeats. */
export const LINK_PROBE_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
export const LINK_PROBE_DEADLINE_MS = 5_000;

export function initialLinkModel(browserOnline: boolean): LinkModel {
  return {
    state: browserOnline ? 'online' : 'offline',
    browserOnline,
    successStreak: 0,
    lastFailureAt: null,
  };
}

export function reduceLink(model: LinkModel, event: LinkEvent): LinkModel {
  switch (event.type) {
    case 'browser-offline':
      return model.state === 'offline' && !model.browserOnline
        ? model
        : { ...model, state: 'offline', browserOnline: false, successStreak: 0 };
    case 'browser-online':
      if (model.browserOnline) return model;
      // The radio is back. That says nothing about a link we already saw
      // failing, so only the offline state is lifted here.
      return {
        ...model,
        browserOnline: true,
        state: model.state === 'offline' ? 'online' : model.state,
        successStreak: 0,
      };
    case 'failure':
      if (!model.browserOnline) return model;
      return { ...model, state: 'degraded', successStreak: 0, lastFailureAt: event.at };
    case 'success': {
      if (!model.browserOnline) return model;
      if (model.state === 'online') return model;
      const streak = event.probe ? RECOVERY_SUCCESS_STREAK : model.successStreak + 1;
      return streak >= RECOVERY_SUCCESS_STREAK
        ? { ...model, state: 'online', successStreak: 0 }
        : { ...model, successStreak: streak };
    }
  }
}

/**
 * Does this error say something about the link (no response, a deadline),
 * rather than about the request? A user abort does not, and neither does a
 * gateway status: that is a response, from a server that is slow or cold.
 */
export function isLinkDegradingError(error: unknown): boolean {
  // An error built from a response carries its status: never link evidence.
  if (typeof (error as { status?: unknown } | null)?.status === 'number') return false;
  if (error instanceof DOMException) {
    if (error.name === 'TimeoutError') return true;
    if (error.name === 'AbortError') return false;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/^HTTP \d{3}\b/.test(message)) return false;
  if (/aborted|AbortError/i.test(message) && !/timed out/i.test(message)) return false;
  if (error instanceof TypeError) return true;
  return isTransportFailure(message);
}

export interface ConnectivityStore {
  getState(): LinkState;
  getDeviceDataInUse(): boolean;
  subscribe(listener: () => void): () => void;
  reportFailure(): void;
  reportSuccess(): void;
  /** Re-arm the probe (the page became visible again). */
  wake(): void;
  /** The browser's own online/offline event. */
  browserEvent(online: boolean): void;
  /** A surface is serving saved device data; call the result to release. */
  markDeviceData(): () => void;
  dispose(): void;
}

export function createConnectivityStore({ browserOnline, probe, visible, now }: {
  browserOnline: () => boolean;
  probe: () => Promise<void>;
  visible: () => boolean;
  now: () => number;
}): ConnectivityStore {
  let model = initialLinkModel(browserOnline());
  let deviceDataHolders = 0;
  const listeners = new Set<() => void>();
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let probeAttempt = 0;
  let probing = false;
  let disposed = false;

  const notify = () => { for (const listener of [...listeners]) listener(); };

  const clearProbe = () => {
    if (probeTimer !== null) clearTimeout(probeTimer);
    probeTimer = null;
  };

  const scheduleProbe = () => {
    if (disposed || probeTimer !== null || probing) return;
    if (model.state !== 'degraded' || !visible()) return;
    const delay = LINK_PROBE_DELAYS_MS[Math.min(probeAttempt, LINK_PROBE_DELAYS_MS.length - 1)];
    probeTimer = setTimeout(async () => {
      probeTimer = null;
      if (disposed || model.state !== 'degraded' || !visible()) return;
      probeAttempt += 1;
      probing = true;
      let ok = false;
      try {
        await probe();
        ok = true;
      } catch {
        ok = false;
      } finally {
        probing = false;
      }
      if (disposed) return;
      if (ok) dispatch({ type: 'success', probe: true });
      scheduleProbe();
    }, delay);
  };

  const dispatch = (event: LinkEvent) => {
    const next = reduceLink(model, event);
    if (next === model) return;
    const changed = next.state !== model.state;
    model = next;
    if (model.state !== 'degraded') {
      clearProbe();
      probeAttempt = 0;
    } else {
      scheduleProbe();
    }
    if (changed) notify();
  };

  return {
    getState: () => model.state,
    getDeviceDataInUse: () => deviceDataHolders > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    reportFailure: () => dispatch({ type: 'failure', at: now() }),
    reportSuccess: () => dispatch({ type: 'success' }),
    browserEvent: (online) => dispatch({ type: online ? 'browser-online' : 'browser-offline' }),
    wake: () => {
      if (browserOnline() !== model.browserOnline) {
        dispatch({ type: browserOnline() ? 'browser-online' : 'browser-offline' });
      }
      scheduleProbe();
    },
    markDeviceData() {
      deviceDataHolders += 1;
      if (deviceDataHolders === 1) notify();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        deviceDataHolders = Math.max(0, deviceDataHolders - 1);
        if (deviceDataHolders === 0) notify();
      };
    },
    dispose() {
      disposed = true;
      clearProbe();
      listeners.clear();
    },
  };
}

// --- Browser singleton -------------------------------------------------------

/** Any response proves the link. A static file costs no function or database. */
async function probeLink(): Promise<void> {
  await fetchWithDeadline(
    `/file.svg?link-probe=${Date.now()}`,
    { method: 'HEAD', cache: 'no-store', credentials: 'omit' },
    LINK_PROBE_DEADLINE_MS,
  );
}

let browserStore: ConnectivityStore | null = null;

function connectivity(): ConnectivityStore | null {
  if (typeof window === 'undefined') return null;
  if (browserStore) return browserStore;
  const store = createConnectivityStore({
    browserOnline: () => window.navigator.onLine !== false,
    probe: probeLink,
    visible: () => document.visibilityState === 'visible',
    now: () => Date.now(),
  });
  window.addEventListener('offline', () => store.browserEvent(false));
  window.addEventListener('online', () => store.browserEvent(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') store.wake();
  });
  browserStore = store;
  return store;
}

const noopUnsubscribe = () => {};

export function getLinkState(): LinkState {
  return connectivity()?.getState() ?? 'online';
}

/** Server snapshot for useSyncExternalStore. */
export function getServerLinkState(): LinkState {
  return 'online';
}

export function subscribeLinkState(listener: () => void): () => void {
  return connectivity()?.subscribe(listener) ?? noopUnsubscribe;
}

export function isDeviceDataInUse(): boolean {
  return connectivity()?.getDeviceDataInUse() ?? false;
}

export function markDeviceDataInUse(): () => void {
  return connectivity()?.markDeviceData() ?? noopUnsubscribe;
}

/** A review-path request failed in transport or ran past its deadline. */
export function reportLinkFailure(): void {
  connectivity()?.reportFailure();
}

/** A request got a response back. */
export function reportLinkSuccess(): void {
  connectivity()?.reportSuccess();
}

/** Report an error only when it says something about the link. */
export function reportLinkError(error: unknown): void {
  if (isLinkDegradingError(error)) reportLinkFailure();
}

export function resetConnectivityForTest(): void {
  browserStore?.dispose();
  browserStore = null;
}
