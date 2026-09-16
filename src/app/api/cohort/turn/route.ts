import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrGuest } from '@/lib/api-utils';
import {
  CohortTurnError,
  serveCohortTurn,
  type CohortTurnRequest,
} from '@/lib/cohort/cohort-turn.server';
import { isCohortHostname } from '@/lib/institution';
import { CLIENT_REQUEST_ID_MAX_LENGTH, CLIENT_REQUEST_ID_PATTERN } from '@/lib/idempotency';
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
const MAX_TURN_BODY_BYTES = 2_048;
const MAX_DRAW_ORDINAL = 1_000_000;
const MAX_TIMEZONE_CHARS = 64;
const MAX_SEARCH_TOPIC_ID_CHARS = 64;
const SEARCH_TOPIC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_KEYS = new Set([
  'serveRequestId',
  'journeyId',
  'nextDrawOrdinal',
  'previousDeliveryId',
  'timezone',
  'searchTopicId',
]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= CLIENT_REQUEST_ID_MAX_LENGTH
    && CLIENT_REQUEST_ID_PATTERN.test(value);
}

function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TIMEZONE_CHARS) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

type ParseResult =
  | { ok: true; value: CohortTurnRequest }
  | { ok: false; code?: 'invalid_search_topic' };

function parseTurnBody(value: unknown): ParseResult {
  if (!isRecord(value) || Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) {
    return { ok: false };
  }
  if (
    !isOpaqueId(value.serveRequestId)
    || !isOpaqueId(value.journeyId)
    || !Number.isSafeInteger(value.nextDrawOrdinal)
    || (value.nextDrawOrdinal as number) < 0
    || (value.nextDrawOrdinal as number) > MAX_DRAW_ORDINAL
    || ('previousDeliveryId' in value && !isOpaqueId(value.previousDeliveryId))
    || ('timezone' in value && !isIanaTimezone(value.timezone))
  ) {
    return { ok: false };
  }

  let searchTopicId: string | undefined;
  if ('searchTopicId' in value) {
    if (
      typeof value.searchTopicId !== 'string'
      || value.searchTopicId.length < 1
      || value.searchTopicId.length > MAX_SEARCH_TOPIC_ID_CHARS
      || !SEARCH_TOPIC_ID_PATTERN.test(value.searchTopicId)
    ) return { ok: false, code: 'invalid_search_topic' };
    searchTopicId = value.searchTopicId;
  }

  return {
    ok: true,
    value: {
      serveRequestId: value.serveRequestId,
      journeyId: value.journeyId,
      nextDrawOrdinal: value.nextDrawOrdinal as number,
      ...('previousDeliveryId' in value
        ? { previousDeliveryId: value.previousDeliveryId as string }
        : {}),
      ...('timezone' in value ? { timezone: value.timezone as string } : {}),
      ...(searchTopicId ? { searchTopicId } : {}),
    },
  };
}

async function readBoundedBody(request: NextRequest): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TURN_BODY_BYTES) {
    throw new RangeError('Turn body is too large');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('Turn body is empty');
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_TURN_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError('Turn body is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(raw) as unknown;
}

export async function POST(request: NextRequest) {
  // URL host is the trusted routing boundary. Body and proxy-style headers are
  // intentionally ignored and cannot opt an md3.info caller into Cohort.
  if (!isCohortHostname(new URL(request.url).hostname)) {
    return json({ error: 'Not found' }, 404);
  }

  let raw: unknown;
  try {
    raw = await readBoundedBody(request);
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
