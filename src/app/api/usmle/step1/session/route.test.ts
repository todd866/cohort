/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-utils', () => ({ requireAuthOrGuest: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkUserRateLimit: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@/lib/usmle/step1-session.server', () => ({
  createStep1Session: vi.fn(),
  Step1ApiError: class Step1ApiError extends Error {},
}));

import { requireAuthOrGuest } from '@/lib/api-utils';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { createStep1Session } from '@/lib/usmle/step1-session.server';
import { GET } from './route';

function request(query = '') {
  return new NextRequest(`http://localhost/api/usmle/step1/session${query}`);
}

describe('GET /api/usmle/step1/session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuthOrGuest).mockResolvedValue({ userId: 'user-1', isGuest: false });
    vi.mocked(checkUserRateLimit).mockResolvedValue({ ok: true });
    vi.mocked(createStep1Session).mockResolvedValue({
      sessionId: 'opaque-session',
      mode: 'daily',
      requestedSize: 10,
      deliveredSize: 0,
      items: [],
    });
  });

  it('returns private no-store when guest minting is rate-limited', async () => {
    vi.mocked(requireAuthOrGuest).mockResolvedValue({
      response: NextResponse.json({ error: 'Too many new guest sessions' }, { status: 429 }),
    });

    const response = await GET(request('?mode=daily'));

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(checkUserRateLimit).not.toHaveBeenCalled();
    expect(createStep1Session).not.toHaveBeenCalled();
  });

  it('uses the signed-in session budget and returns private no-store content', async () => {
    const response = await GET(request(
      '?mode=baseline&size=4&domains=usmle-cardio,usmle-renal&domains=usmle-immunology',
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toContain('Cookie');
    expect(checkUserRateLimit).toHaveBeenCalledWith(
      'user-1',
      'usmle-step1-session',
      20,
      60_000,
    );
    expect(createStep1Session).toHaveBeenCalledWith({
      userId: 'user-1',
      mode: 'baseline',
      size: 4,
      domains: ['usmle-cardio', 'usmle-renal', 'usmle-immunology'],
    });
  });

  it('applies the tighter guest session budget', async () => {
    vi.mocked(requireAuthOrGuest).mockResolvedValue({ userId: 'guest-1', isGuest: true });

    const response = await GET(request('?mode=daily'));

    expect(response.status).toBe(200);
    expect(checkUserRateLimit).toHaveBeenCalledWith(
      'guest-1',
      'usmle-step1-session',
      8,
      60_000,
    );
  });

  it('returns a bounded 400 for invalid mode, size, or domain syntax', async () => {
    for (const query of [
      '?mode=exam',
      '?mode=daily&size=21',
      '?mode=daily&domains=../../private',
    ]) {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(createStep1Session).not.toHaveBeenCalled();
  });

  it('fails closed when the shared rate-limit store cannot grant a token', async () => {
    vi.mocked(checkUserRateLimit).mockResolvedValue({
      ok: false,
      retryAfterMs: 2_100,
      reason: 'store_unavailable',
    });

    const response = await GET(request('?mode=daily'));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(createStep1Session).not.toHaveBeenCalled();
  });
});
