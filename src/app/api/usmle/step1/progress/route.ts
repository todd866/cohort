import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrGuest } from '@/lib/api-utils';
import { logger } from '@/lib/logger';
import { checkUserRateLimit } from '@/lib/rate-limit';
import {
  STEP1_PROGRESS_LIMIT,
  STEP1_RATE_WINDOW_MS,
  step1RateLimit,
} from '@/lib/usmle/step1-rate-limits';
import {
  getStep1Progress,
  Step1ApiError,
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

export async function GET(request: NextRequest) {
  const auth = await requireAuthOrGuest(request);
  if (auth.response) return privateResponse(auth.response);

  const limit = step1RateLimit(auth.isGuest, STEP1_PROGRESS_LIMIT);
  const rateLimit = await checkUserRateLimit(
    auth.userId,
    'usmle-step1-progress',
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

  const timezone = new URL(request.url).searchParams.get('tz')?.trim() || undefined;
  if (timezone && timezone.length > 100) {
    return json({ error: 'Invalid timezone' }, 400);
  }

  try {
    const progress = await getStep1Progress({
      userId: auth.userId,
      ...(timezone ? { timezone } : {}),
    });
    return json(progress);
  } catch (error) {
    if (error instanceof Step1ApiError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    logger.error('USMLE Step 1 progress failed', {
      userId: auth.userId,
      error: String(error),
    });
    return json({ error: 'Could not load Step 1 progress' }, 500);
  }
}
