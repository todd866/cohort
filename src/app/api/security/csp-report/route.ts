import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  readBoundedRequestText,
  RequestBodyTooLargeError,
} from '@/lib/bounded-request-body';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REPORTS_PER_MINUTE = 60;

function clientKey(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

function safeDirective(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const bounded = value.trim().slice(0, 120);
  return /^[a-z0-9 _'*-]+$/i.test(bounded) ? bounded : undefined;
}

function safeLocation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const bounded = value.trim().slice(0, 2_048);
  if (['inline', 'eval', 'self', 'data', 'blob'].includes(bounded)) return bounded;
  try {
    const url = new URL(bounded);
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Report too large' }, { status: 413 });
  }

  const rate = await checkRateLimit(
    `csp-report:${clientKey(request)}`,
    MAX_REPORTS_PER_MINUTE,
    60_000,
  );
  if (!rate.ok) {
    return new NextResponse(null, {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))) },
    });
  }

  let text: string;
  try {
    text = await readBoundedRequestText(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: 'Report too large' }, { status: 413 });
    }
    return NextResponse.json({ error: 'Invalid report' }, { status: 400 });
  }

  try {
    const parsed: unknown = JSON.parse(text);
    const envelope = asRecord(parsed);
    const report = asRecord(envelope?.['csp-report']) ?? asRecord(envelope?.body) ?? envelope;
    if (!report) return NextResponse.json({ error: 'Invalid report' }, { status: 400 });

    logger.warn('csp-violation', {
      documentUri: safeLocation(report['document-uri'] ?? report.documentURL),
      blockedUri: safeLocation(report['blocked-uri'] ?? report.blockedURL),
      sourceFile: safeLocation(report['source-file'] ?? report.sourceFile),
      effectiveDirective: safeDirective(report['effective-directive'] ?? report.effectiveDirective),
      violatedDirective: safeDirective(report['violated-directive'] ?? report.violatedDirective),
      disposition: safeDirective(report.disposition),
      lineNumber: typeof report['line-number'] === 'number' ? report['line-number'] : undefined,
      columnNumber: typeof report['column-number'] === 'number' ? report['column-number'] : undefined,
    });
  } catch {
    return NextResponse.json({ error: 'Invalid report' }, { status: 400 });
  }

  return new NextResponse(null, { status: 204 });
}
