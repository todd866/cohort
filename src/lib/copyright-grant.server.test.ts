import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./prisma', () => ({ default: { user: {} } }));
vi.mock('./logger', () => ({ logger: { warn: vi.fn() } }));

import { createCopyrightGrantAfterSignIn, type CopyrightGrantUpdate } from './copyright-grant.server';

const approvedEmail = 'invited@example.test';
const approvedHash = createHash('sha256').update(approvedEmail).digest('hex');
const verifiedAt = new Date('2026-09-13T00:00:00Z');

function makeHarness() {
  let row: {
    id: string; email: string | null; emailVerified: Date | null;
    imageTier: string; privacyDeletionRequestedAt: Date | null;
  } | null = null;
  const users = {
    findUnique: vi.fn(async () => row && { ...row }),
    updateMany: vi.fn(async ({ where, data }: CopyrightGrantUpdate) => {
      if (!row || Object.entries(where).some(([key, value]) => row?.[key as keyof typeof row] !== value)) {
        return { count: 0 };
      }
      row.imageTier = data.imageTier;
      return { count: 1 };
    }),
  };
  const warn = vi.fn();
  const grant = createCopyrightGrantAfterSignIn({ users, approvedEmailHashes: [approvedHash], warn });
  return {
    users, warn, grant,
    read: () => row,
    register: (overrides: Partial<NonNullable<typeof row>> = {}) => {
      row = { id: 'account-1', email: approvedEmail, emailVerified: verifiedAt,
        imageTier: 'standard', privacyDeletionRequestedAt: null, ...overrides };
    },
  };
}

describe('pending copyright grant after sign-in', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it('keeps approval pending without a precreated user, then grants on first verified sign-in', async () => {
    expect(await h.grant({ userId: 'account-1' })).toBe('unchanged');
    expect(h.users.updateMany).not.toHaveBeenCalled();
    h.register();
    expect(await h.grant({ userId: 'account-1' })).toBe('granted');
    expect(h.read()?.imageTier).toBe('copyright');
    expect(h.users.updateMany).toHaveBeenCalledWith({
      where: { id: 'account-1', email: approvedEmail, emailVerified: verifiedAt,
        imageTier: 'standard', privacyDeletionRequestedAt: null },
      data: { imageTier: 'copyright' },
    });
  });

  it('normalizes only whitespace and case, while guarding the exact stored address', async () => {
    h.register({ email: ' Invited@Example.Test ' });
    expect(await h.grant({ userId: 'account-1' })).toBe('granted');
    expect(h.users.updateMany.mock.calls[0][0].where.email).toBe(' Invited@Example.Test ');
  });

  it.each(['invited+alias@example.test', 'invited@other.test', 'other@example.test', '', null])(
    'never grants a nonmatching primary email %s, even when a profile claims the approved email', async (email) => {
      h.register({ email });
      expect(await h.grant({ userId: 'account-1', account: { provider: 'google', type: 'oidc' },
        profile: { email: approvedEmail, email_verified: true } })).toBe('unchanged');
      expect(h.users.updateMany).not.toHaveBeenCalled();
    },
  );

  it('accepts verified Google OIDC evidence only when it matches the persisted primary address', async () => {
    h.register({ emailVerified: null });
    expect(await h.grant({ userId: 'account-1', account: { provider: 'google', type: 'oidc' },
      profile: { email: 'INVITED@EXAMPLE.TEST', email_verified: true } })).toBe('granted');
  });

  it.each([
    {},
    { account: { provider: 'google', type: 'oidc' }, profile: { email: approvedEmail, email_verified: false } },
    { account: { provider: 'google', type: 'oidc' }, profile: { email: approvedEmail, email_verified: 'true' } },
    { account: { provider: 'google', type: 'oidc' }, profile: { email: 'alias@example.test', email_verified: true } },
    { account: { provider: 'github', type: 'oauth' }, profile: { email: approvedEmail, email_verified: true } },
    { account: { provider: 'google', type: 'credentials' }, profile: { email: approvedEmail, email_verified: true } },
  ])('rejects unverified or mismatched provider evidence %#', async (context) => {
    h.register({ emailVerified: null });
    expect(await h.grant({ userId: 'account-1', ...context })).toBe('unchanged');
    expect(h.users.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'other-account' },
    { privacyDeletionRequestedAt: verifiedAt },
    { imageTier: 'copyright' },
    { imageTier: 'future-tier' },
  ])('preserves ineligible accounts and existing tiers %#', async (overrides) => {
    h.register(overrides);
    expect(await h.grant({ userId: 'account-1' })).toBe('unchanged');
    expect(h.users.updateMany).not.toHaveBeenCalled();
  });

  it('does not create or repeat a write for a previously granted account', async () => {
    h.register();
    await h.grant({ userId: 'account-1' });
    expect(await h.grant({ userId: 'account-1' })).toBe('unchanged');
    expect(h.users.updateMany).toHaveBeenCalledOnce();
  });

  it.each([
    { email: 'replaced@example.test' },
    { emailVerified: null },
    { imageTier: 'future-tier' },
    { privacyDeletionRequestedAt: verifiedAt },
  ])('does not grant if protected account state changes between lookup and update %#', async (change) => {
    h.register();
    const snapshot = { ...h.read()! };
    h.users.findUnique.mockImplementationOnce(async () => {
      h.register(change);
      return snapshot;
    });
    expect(await h.grant({ userId: 'account-1' })).toBe('unchanged');
    expect(h.read()?.imageTier).toBe(change.imageTier ?? 'standard');
  });

  it('leaves authentication available and does not log private database errors', async () => {
    h.users.findUnique.mockRejectedValue(new Error(`query included ${approvedEmail}`));
    expect(await h.grant({ userId: 'account-1' })).toBe('failed');
    expect(h.users.updateMany).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith('pending-copyright-grant-failed');
  });

  it('leaves a failed write pending and can grant at a later sign-in', async () => {
    h.register();
    h.users.updateMany.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await h.grant({ userId: 'account-1' })).toBe('failed');
    expect(h.read()?.imageTier).toBe('standard');
    expect(await h.grant({ userId: 'account-1' })).toBe('granted');
  });

  it('does not query an absent authenticated ID', async () => {
    expect(await h.grant({ userId: '' })).toBe('unchanged');
    expect(h.users.findUnique).not.toHaveBeenCalled();
  });

  it('keeps the operator allowlist server-only and stores only its approved digest', () => {
    const source = readFileSync(new URL('./copyright-grant.server.ts', import.meta.url), 'utf8');
    const policy = readFileSync(new URL('./copyright-grant-policy.server.ts', import.meta.url), 'utf8');
    expect(source).toContain("import 'server-only'");
    expect(policy).toContain("import 'server-only'");
    expect(policy).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    expect(source).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    expect(source).not.toContain('userEmail');
  });
});
