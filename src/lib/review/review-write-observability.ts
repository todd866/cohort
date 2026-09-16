export const REVIEW_VIEWPORT_MIN_PX = 240;
export const REVIEW_VIEWPORT_MAX_PX = 10_000;
export const WEB_REVIEW_ACTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const WEB_REVIEW_ACTION_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type ReviewDeviceBucket = 'mobile' | 'tablet' | 'desktop' | 'unknown';
export type ReviewWriteTransport = 'web_review' | 'mobile_sync' | 'server';
export type ReviewTimestampSource = 'client_action' | 'server_received';

export type ReviewWriteContext = {
  deviceBucket: ReviewDeviceBucket;
  transport: ReviewWriteTransport;
  receivedAt: Date;
  timestampSource: ReviewTimestampSource;
};

export type ReviewWriteClientContext = {
  clientActionAt: string;
  viewportWidth?: number;
};

function isPlausibleViewportWidth(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= REVIEW_VIEWPORT_MIN_PX
    && value <= REVIEW_VIEWPORT_MAX_PX;
}

export function deriveReviewDeviceBucket(input: {
  userAgent?: string | null;
  viewportWidth?: number | null;
}): ReviewDeviceBucket {
  if (isPlausibleViewportWidth(input.viewportWidth)) {
    if (input.viewportWidth < 768) return 'mobile';
    if (input.viewportWidth < 1024) return 'tablet';
    return 'desktop';
  }

  const userAgent = input.userAgent?.trim().toLowerCase();
  if (!userAgent) return 'unknown';

  // Modern iPadOS can present a Macintosh user-agent while retaining the
  // Mobile Safari token, so detect it before the generic mobile branch.
  if (/ipad|tablet|kindle|silk|android(?!.*mobile)|macintosh.*mobile/.test(userAgent)) {
    return 'tablet';
  }
  if (/mobile|iphone|ipod|android.*mobile/.test(userAgent)) {
    return 'mobile';
  }
  if (/windows nt|macintosh|x11|cros|linux x86_64/.test(userAgent)) {
    return 'desktop';
  }
  return 'unknown';
}

export function normalizeWebClientActionAt(
  value: unknown,
  receivedAt: Date,
): {
  actionAt: Date | undefined;
  timestampSource: ReviewTimestampSource;
} {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { actionAt: undefined, timestampSource: 'server_received' };
  }

  const actionAt = new Date(value);
  const actionMs = actionAt.getTime();
  const receivedMs = receivedAt.getTime();
  if (
    Number.isNaN(actionMs)
    || actionMs < receivedMs - WEB_REVIEW_ACTION_MAX_AGE_MS
    || actionMs > receivedMs + WEB_REVIEW_ACTION_MAX_FUTURE_SKEW_MS
  ) {
    return { actionAt: undefined, timestampSource: 'server_received' };
  }

  return { actionAt, timestampSource: 'client_action' };
}

export function captureReviewWriteClientContext(): ReviewWriteClientContext {
  const viewportWidth = typeof window === 'undefined'
    ? undefined
    : window.innerWidth;
  return {
    clientActionAt: new Date().toISOString(),
    ...(isPlausibleViewportWidth(viewportWidth) ? { viewportWidth } : {}),
  };
}

export function buildWebReviewWriteObservability(input: {
  clientActionAt?: unknown;
  viewportWidth?: unknown;
  userAgent?: string | null;
  receivedAt?: Date;
}): {
  actionAt: Date | undefined;
  clientTimestampFingerprint: string | null;
  writeContext: ReviewWriteContext;
} {
  const receivedAt = input.receivedAt ?? new Date();
  const normalized = normalizeWebClientActionAt(input.clientActionAt, receivedAt);
  const parsedClientTimestamp = typeof input.clientActionAt === 'string'
    ? new Date(input.clientActionAt)
    : null;
  const clientTimestampFingerprint = parsedClientTimestamp
    && !Number.isNaN(parsedClientTimestamp.getTime())
    ? parsedClientTimestamp.toISOString()
    : null;
  return {
    actionAt: normalized.actionAt,
    // This is intentionally independent of the age/skew trust decision above.
    // A lost-ack retry must not change fingerprint merely because time passed.
    clientTimestampFingerprint,
    writeContext: {
      deviceBucket: deriveReviewDeviceBucket({
        userAgent: input.userAgent,
        viewportWidth: typeof input.viewportWidth === 'number'
          ? input.viewportWidth
          : undefined,
      }),
      transport: 'web_review',
      receivedAt,
      timestampSource: normalized.timestampSource,
    },
  };
}

export function buildNativeReviewWriteContext(input: {
  actionAt?: Date;
  userAgent?: string | null;
  receivedAt?: Date;
}): ReviewWriteContext {
  return {
    deviceBucket: deriveReviewDeviceBucket({ userAgent: input.userAgent }),
    transport: 'mobile_sync',
    receivedAt: input.receivedAt ?? new Date(),
    timestampSource: input.actionAt ? 'client_action' : 'server_received',
  };
}
