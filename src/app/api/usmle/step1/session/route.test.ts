/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-utils', () => ({ requireAuthOrGuest: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkUserRateLimit: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@/lib/usmle/step1-session-issuance.server', () => ({ issueStep1Session: vi.fn() }));
vi.mock('@/lib/usmle/step1-session.server', () => ({
  Step1ApiError: class Step1ApiError extends Error {},
}));

import { requireAuthOrGuest } from '@/lib/api-utils';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { issueStep1Session } from '@/lib/usmle/step1-session-issuance.server';
import { GET, POST } from './route';

function request(body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/usmle/step1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serveRequestId: 'request-1', ...body }) });
}

describe('POST /api/usmle/step1/session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuthOrGuest).mockResolvedValue({ userId: 'user-1', isGuest: false });
    vi.mocked(checkUserRateLimit).mockResolvedValue({ ok: true });
    vi.mocked(issueStep1Session).mockResolvedValue({
      sessionId: 'opaque-session',
      mode: 'daily',
      requestedSize: 10,
      deliveredSize: 0,
      items: [],
    });
  });

  it('rejects GET without authenticating or creating deliveries', async () => {
    const response = await GET();
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(requireAuthOrGuest).not.toHaveBeenCalled();
    expect(issueStep1Session).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies before minting a guest', async () => {
    const response = await POST(request({ padding: 'x'.repeat(4096) }));
    expect(response.status).toBe(413);
    expect(requireAuthOrGuest).not.toHaveBeenCalled();
  });

  it('returns private no-store when guest minting is rate-limited', async () => {
    vi.mocked(requireAuthOrGuest).mockResolvedValue({
      response: NextResponse.json({ error: 'Too many new guest sessions' }, { status: 429 }),
    });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(checkUserRateLimit).not.toHaveBeenCalled();
    expect(issueStep1Session).not.toHaveBeenCalled();
  });

  it('uses the signed-in session budget and returns private no-store content', async () => {
    const response = await POST(request(
      { mode: 'baseline', size: 4, domains: ['usmle-cardio', 'usmle-renal', 'usmle-immunology'] },
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
    expect(issueStep1Session).toHaveBeenCalledWith({
      userId: 'user-1',
      serveRequestId: 'request-1',
      mode: 'baseline',
      size: 4,
      domains: ['usmle-cardio', 'usmle-renal', 'usmle-immunology'],
    });
    await expect(response.json()).resolves.not.toHaveProperty('hookItemCount');
  });

  it('applies the tighter guest session budget', async () => {
    vi.mocked(requireAuthOrGuest).mockResolvedValue({ userId: 'guest-1', isGuest: true });

    const response = await POST(request());

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
      { mode: 'exam' }, { size: 21 }, { domains: ['../../private'] },
      { serveRequestId: '' }, { serveRequestId: 'x'.repeat(129) }, { userId: 'injected' },
      { size: '10' }, { mode: null },
    ]) {
      const response = await POST(request(query));
      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(issueStep1Session).not.toHaveBeenCalled();
    expect(requireAuthOrGuest).not.toHaveBeenCalled();
  });

  it('fails closed when the shared rate-limit store cannot grant a token', async () => {
    vi.mocked(checkUserRateLimit).mockResolvedValue({
      ok: false,
      retryAfterMs: 2_100,
      reason: 'store_unavailable',
    });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(issueStep1Session).not.toHaveBeenCalled();
  });
});
