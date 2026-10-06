import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrGuest } from '@/lib/api-utils';
import {
  CohortTurnError,
  serveCohortTurn,
} from '@/lib/cohort/cohort-turn.server';
import { isCohortHostname } from '@/lib/institution';
import { parseTurnBody, readBoundedTurnBody } from '@/lib/cohort/turn-request.server';
import { logger } from '@/lib/logger';
import { checkUserRateLimit } from '@/lib/rate-limit';
import {
  STEP1_RATE_WINDOW_MS,
  STEP1_SESSION_LIMIT,
  step1RateLimit,
} from '@/lib/usmle/step1-rate-limits';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
} as const;
function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { ...PRIVATE_HEADERS, ...headers },
  });
}

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control']);
  response.headers.append('Vary', 'Cookie');
  return response;
}

export async function POST(request: NextRequest) {
  // URL host is the trusted routing boundary. Body and proxy-style headers are
  // intentionally ignored and cannot opt an md3.info caller into Cohort.
  if (!isCohortHostname(new URL(request.url).hostname)) {
    return json({ error: 'Not found' }, 404);
  }

  let raw: unknown;
  try {
    raw = await readBoundedTurnBody(request);
  } catch (error) {
    return error instanceof RangeError
      ? json({ error: 'Turn body is too large' }, 413)
      : json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = parseTurnBody(raw);
  if (!parsed.ok) {
    return parsed.code === 'invalid_search_topic'
      ? json({ error: 'Search topic is invalid', code: parsed.code }, 400)
      : json({ error: 'Invalid turn request' }, 400);
  }

  const auth = await requireAuthOrGuest(request);
  if (auth.response) return privateResponse(auth.response);

  try {
    const result = await serveCohortTurn(
      { userId: auth.userId, ...parsed.value },
      {
        authorizeRequest: async (kind) => {
          const limit = step1RateLimit(auth.isGuest, STEP1_SESSION_LIMIT);
          const rateLimit = await checkUserRateLimit(
            auth.userId,
            kind === 'replay' ? 'cohort-turn-replay' : 'cohort-turn',
            kind === 'replay' ? limit * 4 : limit,
            STEP1_RATE_WINDOW_MS,
          );
          return rateLimit.ok
            ? { ok: true }
            : { ok: false, retryAfterMs: rateLimit.retryAfterMs };
        },
      },
    );
    return json(result.response);
  } catch (error) {
    if (error instanceof CohortTurnError) {
      const currentOrdinal = error.details?.currentOrdinal;
      const retryAfterMs = error.details?.retryAfterMs;
      return json({
        error: error.message,
        code: error.code,
        ...(Number.isSafeInteger(currentOrdinal) ? { currentOrdinal } : {}),
      }, error.status, Number.isSafeInteger(retryAfterMs) && (retryAfterMs as number) > 0
        ? { 'Retry-After': String(Math.max(1, Math.ceil((retryAfterMs as number) / 1_000))) }
        : undefined);
    }
    logger.error('Cohort turn delivery failed', {
      userId: auth.userId,
      error: String(error),
    });
    return json({ error: 'Could not build a Cohort turn' }, 500);
  }
}
