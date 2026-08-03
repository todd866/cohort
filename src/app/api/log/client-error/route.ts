import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
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

/**
 * POST /api/log/client-error
 *
 * Fire-and-forget endpoint for client-side error reporting.
 * Accepts sendBeacon payloads and logs them to Vercel function logs
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
