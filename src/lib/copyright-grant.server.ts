import 'server-only';

import { createHash } from 'node:crypto';
import type { User } from '@prisma/client';
import prisma from './prisma';
import { logger } from './logger';
import {
  APPROVED_COPYRIGHT_EMAIL_HASHES,
  APPROVED_COPYRIGHT_MODULE_PRESETS,
} from './copyright-grant-policy.server';

type GrantUser = Pick<User,
  'id' | 'email' | 'emailVerified' | 'imageTier' | 'privacyDeletionRequestedAt' | 'activeModules'>;

export interface CopyrightGrantUpdate {
  where: {
    id: string;
    email: string;
    emailVerified: Date | null;
    imageTier: 'standard';
    privacyDeletionRequestedAt: null;
    activeModules: { equals: string[] };
  };
  data: { imageTier: 'copyright'; activeModules: string[] };
}

interface GrantUsers {
  findUnique(args: {
    where: { id: string };
    select: { [K in keyof GrantUser]: true };
  }): Promise<GrantUser | null>;
  updateMany(args: CopyrightGrantUpdate): Promise<{ count: number }>;
}

interface SuccessfulSignIn {
  userId: string;
  account?: { provider: string; type: string } | null;
  profile?: Record<string, unknown>;
}

const normalizeEmail = (email: unknown): string =>
  typeof email === 'string' ? email.trim().toLowerCase() : '';

/**
 * Call only from Auth.js's successful sign-in event. Recipient selection comes
 * exclusively from the persisted account primary email, never a login alias or
 * the event's user.email. Google proof may verify that same address, not replace it.
 */
export function createCopyrightGrantAfterSignIn({
  users,
  approvedEmailHashes = APPROVED_COPYRIGHT_EMAIL_HASHES,
  modulePresets = APPROVED_COPYRIGHT_MODULE_PRESETS,
  warn = logger.warn,
}: {
  users: GrantUsers;
  approvedEmailHashes?: readonly string[];
  modulePresets?: Readonly<Record<string, readonly string[]>>;
  warn?: (message: string) => void;
}) {
  const approved = new Set(approvedEmailHashes);
  return async ({ userId, account, profile }: SuccessfulSignIn): Promise<'granted' | 'unchanged' | 'failed'> => {
    if (!userId) return 'unchanged';
    try {
      const user = await users.findUnique({
        where: { id: userId },
        select: { id: true, email: true, emailVerified: true,
          imageTier: true, privacyDeletionRequestedAt: true, activeModules: true },
      });
      if (!user || user.id !== userId || user.imageTier !== 'standard'
        || user.privacyDeletionRequestedAt || !user.email) return 'unchanged';

      const email = normalizeEmail(user.email);
      const emailHash = createHash('sha256').update(email).digest('hex');
      if (!email || !approved.has(emailHash)) return 'unchanged';

      // Magic-link login persists emailVerified before this event. OAuth does
      // not, so accept only Google's verified OIDC claim for the same primary.
      const verifiedGooglePrimary = account?.provider === 'google' && account.type === 'oidc'
        && profile?.email_verified === true && normalizeEmail(profile.email) === email;
      if (!user.emailVerified && !verifiedGooglePrimary) return 'unchanged';

      const activeModules = [...user.activeModules];
      const preset = modulePresets[emailHash];
      const nextModules = preset
        ? [...preset, ...activeModules.filter(module => !preset.includes(module))]
        : activeModules;
      const result = await users.updateMany({
        where: { id: userId, email: user.email, emailVerified: user.emailVerified,
          imageTier: 'standard', privacyDeletionRequestedAt: null,
          activeModules: { equals: activeModules } },
        data: { imageTier: 'copyright', activeModules: nextModules },
      });
      return result.count === 1 ? 'granted' : 'unchanged';
    } catch {
      // Leave the grant pending for a later sign-in. Raw database errors can
      // include emails or provider payloads; no such data belongs in this log.
      warn('pending-copyright-grant-failed');
      return 'failed';
    }
  };
}

export const grantPendingCopyrightAfterSignIn = createCopyrightGrantAfterSignIn({ users: prisma.user });
