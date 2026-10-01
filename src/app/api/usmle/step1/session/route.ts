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
  Step1ApiError,
} from '@/lib/usmle/step1-session.server';

import { issueStep1Session, type Step1SessionRequest } from '@/lib/usmle/step1-session-issuance.server';
import { CLIENT_REQUEST_ID_MAX_LENGTH, CLIENT_REQUEST_ID_PATTERN } from '@/lib/idempotency';

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

const MAX_BODY_BYTES = 2_048;

function parseRequest(value: unknown): Step1SessionRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['serveRequestId', 'mode', 'size', 'domains'].includes(key))) return null;
  const mode = row.mode === undefined ? 'daily' : row.mode;
  const size = row.size === undefined ? 10 : row.size;
  if (
    typeof row.serveRequestId !== 'string' || !row.serveRequestId
    || row.serveRequestId.length > CLIENT_REQUEST_ID_MAX_LENGTH
    || !CLIENT_REQUEST_ID_PATTERN.test(row.serveRequestId)
    || (mode !== 'baseline' && mode !== 'daily')
    || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > 20
  ) return null;
  const domains = row.domains === undefined ? [] : row.domains;
  if (!Array.isArray(domains) || domains.length > 10 || domains.some(domain =>
    typeof domain !== 'string' || !/^[a-z0-9][a-z0-9/-]{0,79}$/i.test(domain) || domain.includes('..')
  )) return null;
  return { serveRequestId: row.serveRequestId, mode, size,
    ...(domains.length ? { domains: [...new Set(domains as string[])] } : {}) };
}

async function readBoundedBody(request: NextRequest): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new RangeError();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

export async function GET() {
  return json({ error: 'Use POST to create a session', code: 'method_not_allowed' }, 405, { Allow: 'POST' });
}

export async function POST(request: NextRequest) {
  let parsed: Step1SessionRequest | null;
  try {
    parsed = parseRequest(await readBoundedBody(request));
  } catch (error) {
    return json({ error: 'Invalid session request' }, error instanceof RangeError ? 413 : 400);
  }
  if (!parsed) return json({ error: 'Invalid session request' }, 400);
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

  try {
    return json(await issueStep1Session({ userId: auth.userId, ...parsed }));
  } catch (error) {
    if (error instanceof Step1ApiError) {
      return json({ error: error.message, code: error.code }, error.status,
        error.status === 503 ? { 'Retry-After': '2' } : undefined);
    }
    logger.error('USMLE Step 1 session delivery failed', {
      userId: auth.userId,
      error: String(error),
    });
    return json({ error: 'Could not build a Step 1 session' }, 500);
  }
}
