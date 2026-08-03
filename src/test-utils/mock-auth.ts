import { vi } from 'vitest';
import type { Session } from 'next-auth';

/**
 * Narrow the `auth` function from @/lib/auth to its session-getter overload
 * for vitest mocking. The NextAuth `auth` export has both a middleware and a
 * no-arg session-getter overload, and `vi.mocked(auth)` will default to the
 * middleware signature, causing TS errors when mocking `mockResolvedValue`
 * with a Session object.
 *
 * Usage:
 *   import { mockAuth } from '@/test-utils/mock-auth';
 *   mockAuth(auth).mockResolvedValue({ user: { id: 'user-1' } });
 */
type AuthSessionGetter = () => Promise<Session | null>;

export function mockAuth(auth: unknown) {
  return vi.mocked(auth as AuthSessionGetter);
}
