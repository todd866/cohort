/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuthOrGuest: vi.fn(),
  checkUserRateLimit: vi.fn(),
  serveCohortTurn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@/lib/api-utils', () => ({ requireAuthOrGuest: mocks.requireAuthOrGuest }));
vi.mock('@/lib/rate-limit', () => ({ checkUserRateLimit: mocks.checkUserRateLimit }));
vi.mock('@/lib/logger', () => ({ logger: { error: mocks.loggerError } }));
vi.mock('@/lib/cohort/cohort-turn.server', () => ({
  CohortTurnError: class CohortTurnError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly details?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
  serveCohortTurn: mocks.serveCohortTurn,
}));

import { CohortTurnError } from '@/lib/cohort/cohort-turn.server';
import { POST } from './route';

const validBody = {
  serveRequestId: 'serve-request-1',
  journeyId: 'journey-1',
  nextDrawOrdinal: 3,
  previousDeliveryId: 'delivery-3',
  timezone: 'Australia/Perth',
  searchTopicId: 'heart-function',
};

const session = {
  sessionId: 'journey-1',
  mode: 'daily' as const,
  requestedSize: 1,
  deliveredSize: 1,
  items: [{
    deliveryId: 'delivery-4',
    stem: 'A clinical stem',
    options: [
      { label: 'A', text: 'One' },
      { label: 'B', text: 'Two' },
      { label: 'C', text: 'Three' },
      { label: 'D', text: 'Four' },
    ],
    domain: 'usmle/step1/pulmonary',
    difficulty: 'medium',
    questionType: 'diagnosis',
    attribution: { text: 'md3 contributors', licence: 'CC-BY-4.0' },
  }],
};

function request(
  body: unknown = validBody,
  options: { host?: string; headers?: Record<string, string>; raw?: string } = {},
) {
  const raw = options.raw ?? JSON.stringify(body);
  return new NextRequest(`https://${options.host ?? 'cohort.md'}/api/cohort/turn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: raw,
  });
}

describe('POST /api/cohort/turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthOrGuest.mockResolvedValue({ userId: 'user-1', isGuest: false });
    mocks.checkUserRateLimit.mockResolvedValue({ ok: true });
    mocks.serveCohortTurn.mockImplementation(async (_input, options) => {
      const authorization = await options.authorizeRequest('new');
      if (!authorization.ok) {
        throw new CohortTurnError(
          429,
          'rate_limited',
          'Too many requests',
          { retryAfterMs: authorization.retryAfterMs },
        );
      }
      return { response: session, deduped: false };
    });
  });

  it('fails a non-Cohort URL host before topic lookup, auth, or writes, even with spoof headers', async () => {
    const response = await POST(request(validBody, {
      host: 'md3.info',
      headers: {
        host: 'cohort.md',
        'x-forwarded-host': 'cohort.md',
        'x-md3-surface': 'cohort',
      },
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
    expect(mocks.requireAuthOrGuest).not.toHaveBeenCalled();
    expect(mocks.serveCohortTurn).not.toHaveBeenCalled();
  });

  it('rejects oversized and malformed bodies before auth', async () => {
    const oversized = await POST(request(undefined, { raw: `{"padding":"${'x'.repeat(2_100)}"}` }));
    expect(oversized.status).toBe(413);

    const declaredOversized = await POST(request(validBody, {
      headers: { 'content-length': '2049' },
    }));
    expect(declaredOversized.status).toBe(413);

    const multibyteOversized = await POST(request(undefined, {
      raw: `{"padding":"${'é'.repeat(1_100)}"}`,
    }));
    expect(multibyteOversized.status).toBe(413);

    const malformed = await POST(request(undefined, { raw: '{' }));
    expect(malformed.status).toBe(400);
    expect(mocks.requireAuthOrGuest).not.toHaveBeenCalled();
  });

  it('strictly rejects unknown keys, malformed ids, ordinals, and timezones before auth', async () => {
    const invalidBodies = [
      { ...validBody, surface: 'cohort' },
      { ...validBody, serveRequestId: 'spaces are forbidden' },
      { ...validBody, journeyId: '' },
      { ...validBody, previousDeliveryId: '../delivery' },
      { ...validBody, nextDrawOrdinal: 1.5 },
      { ...validBody, nextDrawOrdinal: 1_000_001 },
      { ...validBody, timezone: 'Definitely/Not_A_Zone' },
    ];

    for (const body of invalidBodies) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
    }
    expect(mocks.requireAuthOrGuest).not.toHaveBeenCalled();
    expect(mocks.serveCohortTurn).not.toHaveBeenCalled();
  });

  it('rejects a forged, syntactically valid topic before delivery work', async () => {
    mocks.serveCohortTurn.mockRejectedValueOnce(new CohortTurnError(
      400,
      'invalid_search_topic',
      'Search topic is invalid',
    ));
    const response = await POST(request({ ...validBody, searchTopicId: 'forged-topic' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_search_topic' });
    expect(mocks.requireAuthOrGuest).toHaveBeenCalledTimes(1);
    expect(mocks.serveCohortTurn).toHaveBeenCalledTimes(1);
  });

  it('authenticates only a valid request and returns the unchanged opaque Step1 shape', async () => {
    const incoming = request();
    const response = await POST(incoming);
    const body = await response.json();

    expect(mocks.requireAuthOrGuest).toHaveBeenCalledWith(incoming);
    expect(mocks.checkUserRateLimit).toHaveBeenCalledWith(
      'user-1',
      'cohort-turn',
      expect.any(Number),
      expect.any(Number),
    );
    expect(mocks.serveCohortTurn).toHaveBeenCalledWith(
      { userId: 'user-1', ...validBody },
      { authorizeRequest: expect.any(Function) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toContain('Cookie');
    expect(body).toEqual(session);
    expect(body).not.toHaveProperty('deduped');
    expect(JSON.stringify(body)).not.toContain('questionId');
  });

  it('returns typed exhaustion and ordinal conflicts without manufacturing a fallback', async () => {
    mocks.serveCohortTurn.mockRejectedValueOnce(new CohortTurnError(
      409,
      'topic_exhausted',
      'No eligible questions remain for this topic',
    ));
    const exhausted = await POST(request());
    expect(exhausted.status).toBe(409);
    await expect(exhausted.json()).resolves.toEqual({
      error: 'No eligible questions remain for this topic',
      code: 'topic_exhausted',
    });

    mocks.serveCohortTurn.mockRejectedValueOnce(new CohortTurnError(
      409,
      'journey_ordinal_conflict',
      'Journey ordinal is stale',
      { currentOrdinal: 4 },
    ));
    const conflict = await POST(request());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: 'Journey ordinal is stale',
      code: 'journey_ordinal_conflict',
      currentOrdinal: 4,
    });
  });

  it('preserves private no-store headers on auth and rate-limit failures', async () => {
    mocks.requireAuthOrGuest.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'Too many new guests' }, { status: 429 }),
    });
    const authFailure = await POST(request());
    expect(authFailure.headers.get('Cache-Control')).toBe('private, no-store');

    mocks.checkUserRateLimit.mockResolvedValueOnce({
      ok: false,
      retryAfterMs: 2_100,
      reason: 'store_unavailable',
    });
    const limited = await POST(request());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('3');
    expect(mocks.serveCohortTurn).toHaveBeenCalledTimes(1);
  });

  it('uses a bounded replay budget when the new-turn budget is depleted', async () => {
    mocks.checkUserRateLimit.mockImplementation(async (_userId, route) => (
      route === 'cohort-turn-replay'
        ? { ok: true }
        : { ok: false, retryAfterMs: 60_000, reason: 'limit_exceeded' }
    ));
    mocks.serveCohortTurn.mockImplementationOnce(async (_input, options) => {
      const authorization = await options.authorizeRequest('replay');
      if (!authorization.ok) throw new Error('replay should have a token');
      return { response: session, deduped: true };
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.checkUserRateLimit).toHaveBeenCalledWith(
      'user-1',
      'cohort-turn-replay',
      expect.any(Number),
      expect.any(Number),
    );
    await expect(response.json()).resolves.toEqual(session);
  });
});
