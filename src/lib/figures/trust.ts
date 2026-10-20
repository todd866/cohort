import type { ImageSidecar, AccessTier } from '@/lib/images/types';

/** The resolver also runs in the laptop daemon, outside Next/Auth's type graph. */
export interface ImageSession {
  user?: { id?: string; imageTier?: string };
}

export const ACCESS_TIER_RANK: Record<AccessTier, number> = {
  'public': 0,
  'auth-required': 1,
  'copyright-required': 2,
};

export function userTrust(session: ImageSession | null): AccessTier {
  if (!session?.user?.id) return 'public';
  return session.user.imageTier === 'copyright' ? 'copyright-required' : 'auth-required';
}

export function canView(sidecar: ImageSidecar, user: AccessTier): boolean {
  const required = sidecar.accessTier ?? 'public';
  return ACCESS_TIER_RANK[user] >= ACCESS_TIER_RANK[required];
}
