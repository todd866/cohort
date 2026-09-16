import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    userEmail: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    verificationToken: {
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}));

import { GET } from './route';
import { prisma } from '@/lib/prisma';

function request(origin: string, query = 'token=opaque-token&id=alias-1') {
  return new NextRequest(`${origin}/api/user/email-aliases/verify?${query}`);
}

describe('GET /api/user/email-aliases/verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_TRUST_MD3_COHORT_HOSTS', 'true');
    vi.mocked(prisma.$transaction).mockImplementation(async (operations: any) => (
      Promise.all(operations)
    ));
  });

  afterEach(() => vi.unstubAllEnvs());

  it('verifies and consumes the token atomically on the Cohort origin', async () => {
    vi.mocked(prisma.verificationToken.findFirst).mockResolvedValue({
      identifier: 'alias:alias-1',
      token: 'opaque-token',
      expires: new Date(Date.now() + 60_000),
    } as never);
    vi.mocked(prisma.userEmail.findUnique).mockResolvedValue({ id: 'alias-1' } as never);
    vi.mocked(prisma.userEmail.update).mockResolvedValue({ id: 'alias-1' } as never);
    vi.mocked(prisma.verificationToken.delete).mockResolvedValue({} as never);

    const response = await GET(request('https://cohort.md'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://cohort.md/profile/settings?success=email_alias_verified',
    );
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.userEmail.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'alias-1' },
      data: expect.objectContaining({ verified: true }),
    }));
    expect(prisma.verificationToken.delete).toHaveBeenCalledWith({
      where: {
        identifier_token: {
          identifier: 'alias:alias-1',
          token: 'opaque-token',
        },
      },
    });
  });

  it('keeps invalid-link feedback on the existing profile settings route', async () => {
    const response = await GET(request('https://md3.info', ''));

    expect(response.headers.get('location')).toBe(
      'https://md3.info/profile/settings?error=invalid_verification_link',
    );
    expect(prisma.verificationToken.findFirst).not.toHaveBeenCalled();
  });

  it('supports an explicitly configured HTTPS FOSS deployment origin', async () => {
    vi.stubEnv('AUTH_URL', 'https://learn.example.org');
    vi.mocked(prisma.verificationToken.findFirst).mockResolvedValue(null);

    const response = await GET(request('https://learn.example.org'));

    expect(response.headers.get('location')).toBe(
      'https://learn.example.org/profile/settings?error=invalid_or_expired_token',
    );
  });

  it('rejects a hostile suffix host without touching verification state', async () => {
    const response = await GET(request('https://cohort.md.evil.example'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Email verification is unavailable for this request origin',
    });
    expect(prisma.verificationToken.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('deletes an expired token and redirects to the same-host settings page', async () => {
    vi.mocked(prisma.verificationToken.findFirst).mockResolvedValue({
      identifier: 'alias:alias-1',
      token: 'opaque-token',
      expires: new Date(Date.now() - 60_000),
    } as never);
    vi.mocked(prisma.verificationToken.delete).mockResolvedValue({} as never);

    const response = await GET(request('https://www.cohort.md'));

    expect(response.headers.get('location')).toBe(
      'https://www.cohort.md/profile/settings?error=verification_link_expired',
    );
    expect(prisma.userEmail.update).not.toHaveBeenCalled();
  });
});
