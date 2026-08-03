import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrGuest } from '@/lib/api-utils';
import { logger } from '@/lib/logger';
import { checkUserRateLimit } from '@/lib/rate-limit';
import {
  STEP1_RATE_WINDOW_MS,
  STEP1_SESSION_LIMIT,
  step1RateLimit,
} from '@/lib/usmle/step1-rate-limits';
import {
  createStep1Session,
  Step1ApiError,
  type Step1SessionMode,
} from '@/lib/usmle/step1-session.server';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
} as const;

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control']);
  response.headers.append('Vary', 'Cookie');
  return response;
}

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { ...PRIVATE_HEADERS, ...headers },
  });
}

function parseRequest(request: NextRequest): {
  mode: Step1SessionMode;
  size: number;
  domains?: string[];
} | null {
  const { searchParams } = new URL(request.url);
  const rawMode = searchParams.get('mode') ?? 'daily';
  if (rawMode !== 'baseline' && rawMode !== 'daily') return null;

  const rawSize = searchParams.get('size');
  if (rawSize != null && !/^\d+$/.test(rawSize)) return null;
  const size = rawSize == null ? 10 : Number(rawSize);
  if (!Number.isSafeInteger(size) || size < 1 || size > 20) return null;

  const domains = searchParams.getAll('domains')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    domains.length > 10
    || domains.some((domain) => !/^[a-z0-9][a-z0-9/-]{0,79}$/i.test(domain) || domain.includes('..'))
  ) {
    return null;
  }
  return {
    mode: rawMode,
    size,
    ...(domains.length > 0 ? { domains: [...new Set(domains)] } : {}),
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuthOrGuest(request);
  if (auth.response) return privateResponse(auth.response);

  const limit = step1RateLimit(auth.isGuest, STEP1_SESSION_LIMIT);
  const rateLimit = await checkUserRateLimit(
    auth.userId,
    'usmle-step1-session',
    limit,
    STEP1_RATE_WINDOW_MS,
  );
  if (!rateLimit.ok) {
    return json(
      { error: 'Too many requests' },
      429,
      { 'Retry-After': String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000))) },
    );
  }

  const parsed = parseRequest(request);
  if (!parsed) return json({ error: 'Invalid session request' }, 400);

  try {
    const result = await createStep1Session({ userId: auth.userId, ...parsed });
    return json(result);
  } catch (error) {
    if (error instanceof Step1ApiError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    logger.error('USMLE Step 1 session delivery failed', {
      userId: auth.userId,
      error: String(error),
    });
    return json({ error: 'Could not build a Step 1 session' }, 500);
  }
}
