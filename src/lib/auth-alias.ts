import type { Adapter, AdapterUser } from 'next-auth/adapters';
import prisma from './prisma';

/**
 * Resolve a login email to a user via a *verified* UserEmail alias row.
 *
 * Security-sensitive: this decides which account an alias email signs into.
 * It therefore only ever honours `verified: true` aliases, matches
 * case-insensitively, and returns null when no verified alias maps to a user.
 * It deliberately does NOT consider primary emails — that is the base
 * adapter's job (see createAliasAwareAdapter).
 */
export async function findUserByVerifiedAlias(email: string): Promise<AdapterUser | null> {
  const alias = await prisma.userEmail.findFirst({
    where: {
      email: { equals: email, mode: 'insensitive' },
      verified: true,
    },
    include: { user: true },
  });

  if (alias?.user) {
    return {
      id: alias.user.id,
      name: alias.user.name,
      email: alias.user.email,
      emailVerified: alias.user.emailVerified,
      image: alias.user.image,
    } as AdapterUser;
  }

  return null;
}

/**
 * Wrap a base NextAuth adapter so getUserByEmail also resolves verified email
 * aliases. The primary-email lookup wins; only when the base adapter finds
 * nothing do we fall back to the verified-alias table.
 */
export function createAliasAwareAdapter(baseAdapter: Adapter): Adapter {
  return {
    ...baseAdapter,
    async getUserByEmail(email: string): Promise<AdapterUser | null> {
      const userByPrimary = await baseAdapter.getUserByEmail?.(email);
      if (userByPrimary) {
        return userByPrimary;
      }
      return findUserByVerifiedAlias(email);
    },
  };
}
