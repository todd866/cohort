import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: vi.fn(function ResendMock() {
    return { emails: { send: mocks.send } };
  }),
}));

vi.mock('@/lib/api-utils', () => ({
  requireAuth: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkUserRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    userEmail: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    verificationToken: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}));

import { POST } from './route';
import { requireAuth } from '@/lib/api-utils';
import { prisma } from '@/lib/prisma';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

function makeRequest(body: object, origin = 'http://localhost') {
  return new NextRequest(`${origin}/api/user/email-aliases`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/user/email-aliases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('RESEND_API_KEY', 're_test_alias_verification');
    vi.stubEnv('EMAIL_FROM', 'Study <mail@example.org>');
    mocks.send.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    vi.mocked(checkUserRateLimit).mockResolvedValue({ ok: true });
    // By default, run the transaction callback directly against mocks.
    vi.mocked(prisma.$transaction).mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(prisma);
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg;
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('returns auth response when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    });

    const res = await POST(makeRequest({ email: 'student@example.com' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Authentication required');
  });

  it('returns 400 for invalid JSON body', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1' });

    const req = new NextRequest('http://localhost/api/user/email-aliases', {
      method: 'POST',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid JSON body');
  });

  it('returns 400 when email is missing', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1' });

    const res = await POST(makeRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Required');
  });

  it('returns 400 for invalid email format', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1' });

    const res = await POST(makeRequest({ email: 'not-an-email' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid email format');
  });

  it('creates alias and verification token on valid request', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1' });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ email: 'primary@example.com' } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.userEmail.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.userEmail.create).mockResolvedValue({
      id: 'alias-1',
      email: 'student@example.com',
      verified: false,
      label: 'Uni',
    } as never);
    vi.mocked(prisma.verificationToken.create).mockResolvedValue({} as never);

    const res = await POST(makeRequest({ email: 'Student@Example.com', label: 'Uni' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.alias.email).toBe('student@example.com');
    expect(prisma.userEmail.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'student@example.com',
          userId: 'user-1',
          label: 'Uni',
        }),
      })
    );
    expect(prisma.verificationToken.create).toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it('fails before any database write when outbound email is not configured', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1' });
    vi.stubEnv('RESEND_API_KEY', '');

    const res = await POST(makeRequest({ email: 'student@example.com' }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: 'Email verification is not configured for this deployment',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('fails before any database write when the sender identity is missing', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1' });
    vi.stubEnv('EMAIL_FROM', '');

    const res = await POST(makeRequest({ email: 'student@example.com' }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: 'Email verification is not configured for this deployment',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('keeps a Cohort alias link and branding on cohort.md', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_TRUST_MD3_COHORT_HOSTS', 'true');
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1' });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ email: 'primary@example.com' } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.userEmail.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.userEmail.create).mockResolvedValue({
      id: 'alias-1',
      email: 'student@example.com',
      verified: false,
      label: null,
    } as never);
    vi.mocked(prisma.verificationToken.create).mockResolvedValue({} as never);

    const res = await POST(makeRequest(
      { email: 'student@example.com' },
      'https://cohort.md',
    ));

    expect(res.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      from: 'Study <mail@example.org>',
      subject: 'Verify your email alias - Cohort',
      html: expect.stringContaining('https://cohort.md/api/user/email-aliases/verify?'),
    }));
  });

  it('rejects an untrusted request origin before database access', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_TRUST_MD3_COHORT_HOSTS', 'true');
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1' });

    const res = await POST(makeRequest(
      { email: 'student@example.com' },
      'https://cohort.md.evil.example',
    ));

    expect(res.status).toBe(400);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rate limits verification mail before alias creation', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1' });
    vi.mocked(checkUserRateLimit).mockResolvedValue({
      ok: false,
      retryAfterMs: 30_000,
      reason: 'limit_exceeded',
    });

    const res = await POST(makeRequest({ email: 'student@example.com' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rolls back the alias when Resend returns an error result', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1' });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ email: 'primary@example.com' } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.userEmail.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.userEmail.create).mockResolvedValue({
      id: 'alias-1',
      email: 'student@example.com',
      verified: false,
      label: null,
    } as never);
    vi.mocked(prisma.verificationToken.create).mockResolvedValue({} as never);
    vi.mocked(prisma.verificationToken.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.userEmail.delete).mockResolvedValue({ id: 'alias-1' } as never);
    mocks.send.mockResolvedValue({
      data: null,
      error: { message: 'mail rejected for learner@example.com' },
    });

    const res = await POST(makeRequest({ email: 'student@example.com' }));

    expect(res.status).toBe(502);
    expect(prisma.verificationToken.deleteMany).toHaveBeenCalledWith({
      where: { identifier: 'alias:alias-1' },
    });
    expect(prisma.userEmail.delete).toHaveBeenCalledWith({ where: { id: 'alias-1' } });
    const deliveryLog = vi.mocked(logger.error).mock.calls.find(
      ([message]) => message === 'Email send failed — rolling back alias',
    );
    expect(deliveryLog?.[1]).toEqual({
      userId: 'user-1',
      aliasId: 'alias-1',
      provider: 'resend',
      reason: 'delivery_failed',
    });
    expect(JSON.stringify(deliveryLog)).not.toContain('learner@example.com');
  });
});
