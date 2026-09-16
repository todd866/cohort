/**
 * Client review-load stage timing — joins prefs gate, flush, and unified-session
 * waits into one queryable beacon. Scalar metadata only.
 */

export type ReviewLoadOutcome = 'first_card' | 'failed' | 'exhausted';

export interface ReviewLoadMarks {
  nav: number;
  prefsReady?: number;
  fetchStart?: number;
  sessionTtfb?: number;
  firstCard?: number;
}

export interface ReviewLoadStageMs {
  prefsReadyMs?: number;
  fetchStartMs?: number;
  sessionTtfbMs?: number;
  firstCardMs?: number;
}

export type UaClass = 'ios' | 'android' | 'desktop' | 'unknown';

/**
 * Why a load failed, when there is no HTTP status to point at.
 *
 * 2026-09-14: a learner's review load failed twice in eight seconds. Both rows
 * recorded `outcome: 'failed'`, `attempts: 2`, and nothing else — the health
 * check printed "terminal statuses none recorded" because `markHttpFailure`
 * only accepts 400-599. The server had answered the previous request in 1.3s,
 * so the interesting failures are exactly the ones with no status: a dropped
 * connection, a timeout, a body that would not parse. Those were, and are, the
 * cases the beacon could not describe.
 *
 * Scalar and non-identifying by construction: a classification and an error
 * CLASS name, never a message (messages carry URLs, ids and occasionally
 * server prose).
 */
export type ReviewLoadFailureKind =
  | 'http'
  | 'network'
  | 'timeout'
  | 'abort'
  | 'parse'
  | 'unknown';

export interface ReviewLoadFailure {
  failureKind: ReviewLoadFailureKind;
  errorName?: string;
  httpStatus?: number;
}

export function classifyReviewLoadFailure(error: unknown): ReviewLoadFailure {
  if (!(error instanceof Error)) return { failureKind: 'unknown' };
  const errorName = error.name;

  // An explicit status wins: it is the most specific thing we know.
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
    return { failureKind: 'http', errorName, httpStatus: status };
  }

  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    if (errorName === 'TimeoutError') return { failureKind: 'timeout', errorName };
    if (errorName === 'AbortError') return { failureKind: 'abort', errorName };
  }
  // `fetch` rejects with a bare TypeError for every transport-level failure —
  // DNS, TLS, connection reset, offline. It is the single most likely cause of
  // a status-less failure and was previously indistinguishable from the rest.
  if (error instanceof TypeError) return { failureKind: 'network', errorName };
  if (error instanceof SyntaxError) return { failureKind: 'parse', errorName };
  return { failureKind: 'unknown', errorName };
}

export interface ReviewLoadBeaconPayload extends ReviewLoadStageMs {
  kind: 'review_load';
  url?: string;
  httpStatus?: number;
  failureKind?: ReviewLoadFailureKind;
  errorName?: string;
  sessionServerMs?: number;
  path?: string;
  attempts?: number;
  outcome: ReviewLoadOutcome;
  standalone?: boolean;
  uaClass: UaClass;
  ts: number;
}

/** Parse `total;dur=…` from a Server-Timing header value. */
export function parseServerTimingTotalMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const match = /(?:^|,)\s*total\s*;\s*dur\s*=\s*([0-9]+(?:\.[0-9]+)?)/i.exec(header);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function reviewLoadStageMs(marks: ReviewLoadMarks): ReviewLoadStageMs {
  const out: ReviewLoadStageMs = {};
  if (marks.prefsReady !== undefined) {
    out.prefsReadyMs = marks.prefsReady - marks.nav;
  }
  if (marks.fetchStart !== undefined) {
    out.fetchStartMs = marks.fetchStart - marks.nav;
  }
  if (marks.sessionTtfb !== undefined) {
    out.sessionTtfbMs = marks.sessionTtfb - marks.nav;
  }
  if (marks.firstCard !== undefined) {
    out.firstCardMs = marks.firstCard - marks.nav;
  }
  return out;
}

export function classifyUa(ua: string | undefined): UaClass {
  if (!ua) return 'unknown';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows|Macintosh|Linux/i.test(ua)) return 'desktop';
  return 'unknown';
}

export function buildReviewLoadBeaconPayload(args: {
  marks: ReviewLoadMarks;
  sessionServerMs?: number | null;
  httpStatus?: number | null;
  path?: string | null;
  attempts?: number;
  outcome: ReviewLoadOutcome;
  standalone?: boolean;
  ua?: string;
  url?: string;
  now?: number;
  failureKind?: ReviewLoadFailureKind | null;
  errorName?: string | null;
}): ReviewLoadBeaconPayload {
  const stages = reviewLoadStageMs(args.marks);
  return {
    kind: 'review_load',
    url: args.url,
    ...stages,
    ...(args.sessionServerMs != null ? { sessionServerMs: args.sessionServerMs } : {}),
    ...(args.httpStatus != null ? { httpStatus: args.httpStatus } : {}),
    ...(args.failureKind ? { failureKind: args.failureKind } : {}),
    ...(args.errorName ? { errorName: args.errorName } : {}),
    ...(args.path ? { path: args.path } : {}),
    ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
    outcome: args.outcome,
    ...(args.standalone !== undefined ? { standalone: args.standalone } : {}),
    uaClass: classifyUa(args.ua),
    ts: args.now ?? Date.now(),
  };
}

/**
 * Fire-and-forget beacon. Never throws — timing must not break the review feed.
 */
export function reportReviewLoad(payload: ReviewLoadBeaconPayload): void {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      return;
    }
    const body = {
      ...payload,
      url: payload.url
        ?? (typeof window !== 'undefined'
          ? `${window.location.origin}${window.location.pathname}`
          : undefined),
    };
    navigator.sendBeacon('/api/log/client-error', JSON.stringify(body));
  } catch {
    // never let telemetry break review
  }
}

/** Mutable collector used across ReviewPageClient + useReviewSession. */
export class ReviewLoadTimer {
  private marks: ReviewLoadMarks;
  private sessionServerMs: number | null = null;
  private httpStatus: number | null = null;
  private path: string | null = null;
  private attempts = 0;
  private reported = false;
  private failureKind: ReviewLoadFailureKind | null = null;
  private errorName: string | null = null;

  constructor(nav = typeof performance !== 'undefined' ? performance.now() : Date.now()) {
    this.marks = { nav };
  }

  markPrefsReady(): void {
    if (this.marks.prefsReady === undefined) {
      this.marks.prefsReady = performance.now();
    }
  }

  markFetchStart(): void {
    if (this.marks.fetchStart === undefined) {
      this.marks.fetchStart = performance.now();
    }
  }

  markFirstCard(): void {
    if (this.marks.firstCard === undefined) {
      this.marks.firstCard = performance.now();
    }
  }

  markSessionTtfb(serverTimingHeader?: string | null, path?: string | null): void {
    if (this.marks.sessionTtfb === undefined) {
      this.marks.sessionTtfb = performance.now();
    }
    const parsed = parseServerTimingTotalMs(serverTimingHeader ?? null);
    if (parsed != null) this.sessionServerMs = parsed;
    if (path) this.path = path;
  }

  setAttempts(n: number): void {
    this.attempts = n;
  }

  markHttpFailure(status: number): void {
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      this.httpStatus = status;
    }
  }

  clearHttpFailure(): void {
    this.httpStatus = null;
  }

  /**
   * Record WHY a load failed. Call with the thrown value at the point of
   * failure; classification happens here so no call site has to know the
   * taxonomy. Keeps the first failure — for a retried load that is the one
   * that describes the original fault, not the state after retries.
   */
  markFailure(error: unknown): void {
    if (this.failureKind !== null) return;
    const classified = classifyReviewLoadFailure(error);
    this.failureKind = classified.failureKind;
    this.errorName = classified.errorName ?? null;
    if (classified.httpStatus != null) this.httpStatus = classified.httpStatus;
  }

  /** Test seam: the payload `report()` would send, without a beacon. */
  debugPayload(outcome: ReviewLoadOutcome): ReviewLoadBeaconPayload {
    return buildReviewLoadBeaconPayload({
      marks: this.marks,
      sessionServerMs: this.sessionServerMs,
      httpStatus: this.httpStatus,
      failureKind: this.failureKind,
      errorName: this.errorName,
      path: this.path,
      attempts: this.attempts || undefined,
      outcome,
      ua: undefined,
    });
  }

  report(outcome: ReviewLoadOutcome): void {
    if (this.reported) return;
    this.reported = true;
    if (outcome === 'first_card' && this.marks.firstCard === undefined) {
      this.marks.firstCard = performance.now();
    }
    const standalone =
      typeof window !== 'undefined'
      && (
        window.matchMedia('(display-mode: standalone)').matches
        || (navigator as { standalone?: boolean }).standalone === true
      );
    reportReviewLoad(
      buildReviewLoadBeaconPayload({
        marks: this.marks,
        sessionServerMs: this.sessionServerMs,
        httpStatus: this.httpStatus,
        failureKind: this.failureKind,
        errorName: this.errorName,
        path: this.path,
        attempts: this.attempts || undefined,
        outcome,
        standalone,
        ua: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      }),
    );
  }
}
