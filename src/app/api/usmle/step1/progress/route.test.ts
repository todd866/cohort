/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-utils', () => ({ requireAuthOrGuest: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkUserRateLimit: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@/lib/usmle/step1-session.server', () => ({
  getStep1Progress: vi.fn(),
  Step1ApiError: class Step1ApiError extends Error {},
}));

import { requireAuthOrGuest } from '@/lib/api-utils';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { getStep1Progress } from '@/lib/usmle/step1-session.server';
import { GET } from './route';

function request(query = '') {
  return new NextRequest(`http://localhost/api/usmle/step1/progress${query}`);
}

describe('GET /api/usmle/step1/progress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuthOrGuest).mockResolvedValue({ userId: 'user-1', isGuest: false });
    vi.mocked(checkUserRateLimit).mockResolvedValue({ ok: true });
    vi.mocked(getStep1Progress).mockResolvedValue({
      corpus: { eligible: 10 },
      baseline: { total: 5, attempted: 2, correct: 1, remaining: 3, complete: false },
      coverage: { attempted: 2, unseen: 8 },
      activity: { totalAttempts: 3, correctAttempts: 1, todayAttempts: 1, recent7dAttempts: 3 },
      domains: [],
      dailyTarget: 10,
      nextAction: 'baseline',
      limitations: ['Descriptive coverage only; not an exam score or pass prediction.'],
    });
  });

  it('applies no-store when guest creation is refused', async () => {
    vi.mocked(requireAuthOrGuest).mockResolvedValue({
      response: NextResponse.json({ error: 'Too many new guest sessions' }, { status: 429 }),
    });

    const response = await GET(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getStep1Progress).not.toHaveBeenCalled();
  });

  it('uses the signed-in limiter and returns only the descriptive domain result', async () => {
    const response = await GET(request('?tz=Australia%2FPerth'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toContain('Cookie');
    expect(checkUserRateLimit).toHaveBeenCalledWith(
      'user-1',
      'usmle-step1-progress',
      30,
      60_000,
    );
    expect(getStep1Progress).toHaveBeenCalledWith({
      userId: 'user-1',
      timezone: 'Australia/Perth',
    });
    expect(body).not.toHaveProperty('readiness');
    expect(body).not.toHaveProperty('predictedScore');
  });

  it('applies the tighter guest progress budget', async () => {
    vi.mocked(requireAuthOrGuest).mockResolvedValue({ userId: 'guest-1', isGuest: true });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(checkUserRateLimit).toHaveBeenCalledWith(
      'guest-1',
      'usmle-step1-progress',
      12,
      60_000,
    );
  });

  it('bounds timezone input before the domain query', async () => {
    const response = await GET(request(`?tz=${'x'.repeat(101)}`));
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getStep1Progress).not.toHaveBeenCalled();
  });

  it('fails closed under shared rate limiting', async () => {
    vi.mocked(checkUserRateLimit).mockResolvedValue({
      ok: false,
      retryAfterMs: 900,
      reason: 'limit_exceeded',
    });

    const response = await GET(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(getStep1Progress).not.toHaveBeenCalled();
  });
});
