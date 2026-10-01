// next-auth session config, kept in its own side-effect-free module so it can be
// unit-tested without initializing NextAuth / Prisma / providers (which happens
// on import of auth.ts).
//
// 1 year — active users roll forward indefinitely (see Providers.tsx refetch);
// only a fully-dormant user (no app open for a year) is asked to re-login. This
// intentionally trades stricter expiry for PWA reliability on a trusted-device
// study app. next-auth uses maxAge for both the DB `expires` and the session
// cookie expiry, and updateAge only to throttle how often the session is rolled
// on access.
export const SESSION_CONFIG = {
  strategy: 'database' as const,
  maxAge: 365 * 24 * 60 * 60, // 1 year
  updateAge: 24 * 60 * 60, // roll the session at most once/day on access
};

// Do not set pages.newUser here. Auth.js gives that page precedence over the
// verified callback URL, which would discard the review intent that led a guest
// to sign in. The ordinary callback already lands a zero-history learner in the
// starter lane, so a separate welcome redirect is unnecessary.
export const AUTH_PAGES = {
  signIn: '/auth/signin',
  error: '/auth/signin',
} as const;
