import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { auth } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  readBoundedRequestText,
  RequestBodyTooLargeError,
} from '@/lib/bounded-request-body';

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 8 * 1024;

function getRateLimitKey(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  const userAgent = request.headers.get('user-agent')?.slice(0, 120) || 'unknown';
  return forwardedFor || realIp || `ua:${userAgent}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
}

function safeUrl(value: unknown): string | undefined {
  const text = safeText(value, 2_000);
  if (!text) return undefined;
  try {
    const url = new URL(text, 'https://md3.info');
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function finiteNonNegInt(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n === undefined || n < 0) return undefined;
  return Math.round(n);
}

function finiteHttpStatus(value: unknown): number | undefined {
  const n = finiteNonNegInt(value);
  return n !== undefined && n >= 400 && n <= 599 ? n : undefined;
}

const UA_CLASSES = new Set(['ios', 'android', 'desktop', 'unknown']);
const OUTCOMES = new Set(['first_card', 'failed', 'exhausted']);
// Closed set, not free text: this is an unauthenticated beacon body, and the
// value is written straight into LearningEvent.metadata where audits read it.
const FAILURE_KINDS = new Set(['http', 'network', 'timeout', 'abort', 'parse', 'unknown']);

function handleReviewLoad(body: Record<string, unknown>): void {
  const outcomeRaw = safeText(body.outcome, 32);
  const outcome = outcomeRaw && OUTCOMES.has(outcomeRaw) ? outcomeRaw : 'failed';
  const uaClassRaw = safeText(body.uaClass, 16);
  const uaClass = uaClassRaw && UA_CLASSES.has(uaClassRaw) ? uaClassRaw : 'unknown';
  const metadata = {
    prefsReadyMs: finiteNonNegInt(body.prefsReadyMs),
    fetchStartMs: finiteNonNegInt(body.fetchStartMs),
    sessionTtfbMs: finiteNonNegInt(body.sessionTtfbMs),
    firstCardMs: finiteNonNegInt(body.firstCardMs),
    httpStatus: finiteHttpStatus(body.httpStatus),
    // WHY a status-less load failed. Without these two the 2026-09-14 failures
    // were unattributable after the fact: outcome 'failed', attempts 2, and no
    // other evidence. `errorName` is the error CLASS only — never a message,
    // which would carry urls, ids and server prose into the event stream.
    failureKind: (() => {
      const raw = safeText(body.failureKind, 16);
      return raw && FAILURE_KINDS.has(raw) ? raw : null;
    })(),
    errorName: safeText(body.errorName, 40),
    sessionServerMs: finiteNumber(body.sessionServerMs),
    path: safeText(body.path, 64),
    attempts: finiteNonNegInt(body.attempts),
    outcome,
    standalone: body.standalone === true,
    uaClass,
  };

  logger.warn('review_load', {
    url: safeUrl(body.url),
    ...metadata,
    ts: finiteNumber(body.ts),
  });

  after(async () => {
    try {
      const session = await auth();
      const userId = session?.user?.id;
      if (!userId) return;
      await prisma.learningEvent.create({
        data: {
          userId,
          eventType: 'review_load',
          sourceType: 'session',
          sourceId: 'review_load',
          responseMs: metadata.firstCardMs ?? metadata.sessionTtfbMs ?? null,
          metadata,
        },
      });
    } catch (err) {
      logger.warn('review_load persist failed', { error: String(err) });
    }
  });
}

/**
 * POST /api/log/client-error
 *
 * Fire-and-forget endpoint for client-side error reporting and review-load
 * timing. Accepts sendBeacon payloads and logs them to Vercel function logs
 * so we have visibility into what mobile users actually experience.
 */
export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Report too large' }, { status: 413 });
  }

  const rateLimit = await checkRateLimit(`client-error:${getRateLimitKey(request)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.ok) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rateLimit.retryAfterMs / 1000)) } },
    );
  }

  try {
    const text = await readBoundedRequestText(request, MAX_BODY_BYTES);
    const body = asRecord(JSON.parse(text));
    if (!body) return new NextResponse(null, { status: 204 });

    if (body.kind === 'review_load') {
      handleReviewLoad(body);
      return new NextResponse(null, { status: 204 });
    }

    if (body.kind === 'guest_progress_claim') {
      logger.warn('guest_progress_claim_client', {
        url: safeUrl(body.url),
        outcome: safeText(body.outcome, 32),
        autoRetryCount: finiteNonNegInt(body.autoRetryCount),
        error: safeText(body.error, 300),
        ts: finiteNumber(body.ts),
      });
      return new NextResponse(null, { status: 204 });
    }

    logger.warn('client-error', {
      url: safeUrl(body.url),
      error: safeText(body.error, 1_000),
      status: finiteNumber(body.status),
      elapsed: finiteNumber(body.elapsed),
      attempts: finiteNumber(body.attempts),
      ua: safeText(body.ua, 300),
      ts: finiteNumber(body.ts),
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: 'Report too large' }, { status: 413 });
    }
    // Malformed beacon — ignore
  }
  return new NextResponse(null, { status: 204 });
}
