/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuthOrExistingGuest: vi.fn(),
  checkUserRateLimit: vi.fn(),
  gradeCohortCard: vi.fn(),
  serveCohortTurn: vi.fn(),
}));
vi.mock('next/server', async () => ({
  ...(await vi.importActual<typeof import('next/server')>('next/server')),
  after: vi.fn(),
}));
vi.mock('@/lib/api-utils', () => ({ requireAuthOrExistingGuest: mocks.requireAuthOrExistingGuest }));
vi.mock('@/lib/rate-limit', () => ({ checkUserRateLimit: mocks.checkUserRateLimit }));
vi.mock('@/lib/cohort/card-grade.server', () => ({ gradeCohortCard: mocks.gradeCohortCard }));
vi.mock('@/lib/cohort/cohort-turn.server', () => ({
  serveCohortTurn: mocks.serveCohortTurn,
  CohortTurnError: class CohortTurnError extends Error {},
}));

import { POST } from './route';

const body = { deliveryId: 'delivery-opaque-000001', confidence: 3, clientRequestId: 'req-000001', responseTimeMs: 4_200 };
const nextTurn = {
  serveRequestId: 'turn-000001', journeyId: 'journey-000001', nextDrawOrdinal: 1,
  previousDeliveryId: body.deliveryId, searchTopicId: 'module-anatomy', timezone: 'Australia/Perth',
};
function request(host = 'cohort.md', payload: unknown = body) {
  return new NextRequest(`https://${host}/api/cohort/card-grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('POST /api/cohort/card-grade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthOrExistingGuest.mockResolvedValue({ userId: 'guest-1', isGuest: true, response: null });
    mocks.checkUserRateLimit.mockResolvedValue({ ok: true });
    mocks.gradeCohortCard.mockResolvedValue({ status: 200, body: { ok: true, deduped: false } });
    mocks.serveCohortTurn.mockResolvedValue({ response: { sessionId: nextTurn.journeyId, mode: 'daily', requestedSize: 1, deliveredSize: 1, items: [] }, deduped: false });
  });

  it('404s on any host but Cohort, before auth or a body read', async () => {
    const response = await POST(request('md3.info'));
    expect(response.status).toBe(404);
    expect(mocks.requireAuthOrExistingGuest).not.toHaveBeenCalled();
  });

  it('grades for a guest who already has a session, and never mints one', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deduped: false });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.gradeCohortCard).toHaveBeenCalledWith(
      { userId: 'guest-1', deliveryId: 'delivery-opaque-000001', confidence: 3, clientRequestId: 'req-000001', responseTimeMs: 4_200 },
      expect.objectContaining({ schedulePostCommit: expect.any(Function) }),
    );
  });

  it('returns the auth response when there is no identity', async () => {
    mocks.requireAuthOrExistingGuest.mockResolvedValue({ response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.gradeCohortCard).not.toHaveBeenCalled();
  });

  it('refuses extra fields, a card id, and an out-of-range confidence', async () => {
    for (const payload of [{ ...body, cardId: 'x' }, { ...body, confidence: 5 }, { ...body, deliveryId: 'x' }, { confidence: 3 }]) {
      expect((await POST(request('cohort.md', payload))).status).toBe(400);
    }
    expect(mocks.gradeCohortCard).not.toHaveBeenCalled();
  });

  it('rate-limits with a Retry-After', async () => {
    mocks.checkUserRateLimit.mockResolvedValue({ ok: false, retryAfterMs: 2_500 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3');
  });

  it('passes the grade outcome through', async () => {
    mocks.gradeCohortCard.mockResolvedValue({ status: 410, body: { error: 'gone', code: 'delivery_revoked' } });
    const response = await POST(request());
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'gone', code: 'delivery_revoked' });
  });

  it('grades before selecting the next turn and returns both acknowledgements', async () => {
    const response = await POST(request('cohort.md', { ...body, nextTurn }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, deduped: false, nextTurn: expect.objectContaining({ sessionId: nextTurn.journeyId }) });
    expect(mocks.gradeCohortCard.mock.invocationCallOrder[0]).toBeLessThan(mocks.serveCohortTurn.mock.invocationCallOrder[0]);
    expect(mocks.serveCohortTurn).toHaveBeenCalledWith({ userId: 'guest-1', ...nextTurn }, expect.any(Object));
  });

  it('requires the continuation to name the delivery being graded', async () => {
    const response = await POST(request('cohort.md', { ...body, nextTurn: { ...nextTurn, previousDeliveryId: 'different-delivery' } }));
    expect(response.status).toBe(400);
    expect(mocks.gradeCohortCard).not.toHaveBeenCalled();
  });

  it('keeps the committed grade acknowledgement when continuation rate limiting rejects', async () => {
    mocks.checkUserRateLimit
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, retryAfterMs: 2_500 });
    mocks.serveCohortTurn.mockImplementationOnce(async (_input: unknown, options: { authorizeRequest: (kind: 'new') => Promise<{ ok: boolean }> }) => {
      const authorization = await options.authorizeRequest('new');
      if (!authorization.ok) throw new Error('rate limited');
      return { response: {}, deduped: false };
    });
    const response = await POST(request('cohort.md', { ...body, nextTurn }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deduped: false });
    expect(mocks.checkUserRateLimit).toHaveBeenCalledTimes(2);
  });

  it('keeps the committed grade acknowledgement when continuation fails', async () => {
    mocks.checkUserRateLimit.mockResolvedValue({ ok: true });
    mocks.serveCohortTurn.mockRejectedValueOnce(new Error('turn unavailable'));
    const response = await POST(request('cohort.md', { ...body, nextTurn }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deduped: false });
  });
});
