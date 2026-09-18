/**
 * The session object the client is allowed to see.
 *
 * Auth.js hands the session callback `{ ...sessionRow, user: userRow }` with
 * the FULL adapter user row attached and, until 2026-09-18, the callback
 * mutated that object and returned it. Measured on a long-lived account, the
 * `/api/auth/session` response ran to tens of kilobytes: every User column,
 * including the `feedProfile` JSON blob and the session token itself, fetched
 * twice per page load by `useSession`. The client reads nine fields of it.
 *
 * So the payload is rebuilt from a whitelist rather than filtered from the row.
 * Adding a column to `User` must never widen what a browser receives.
 *
 * The access fields are read from the adapter row when it carries them (the
 * Prisma adapter returns the whole row, so in this deployment it always does),
 * which removes a second `user.findUnique` from every authenticated request.
 */

export interface SessionPayloadUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  betaAccess: boolean;
  institution: string | null;
  imageTier: 'standard' | 'copyright';
  isAdmin: boolean;
  hasVideoAccess: boolean;
}

export interface SessionPayload {
  expires: string;
  user: SessionPayloadUser;
}

interface AdapterRow {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  betaAccess?: boolean | null;
  institution?: string | null;
  imageTier?: string | null;
}

export function buildSessionPayload({
  session,
  user,
  isAdminEmail,
  hasVideoAccess,
}: {
  session: { expires: string };
  user: AdapterRow;
  isAdminEmail: (email: string | null | undefined) => boolean;
  hasVideoAccess: (email: string | null | undefined) => boolean;
}): SessionPayload {
  return {
    expires: session.expires,
    user: {
      id: user.id,
      name: user.name ?? null,
      email: user.email ?? null,
      image: user.image ?? null,
      betaAccess: user.betaAccess ?? false,
      institution: user.institution ?? null,
      imageTier: user.imageTier === 'copyright' ? 'copyright' : 'standard',
      isAdmin: isAdminEmail(user.email),
      hasVideoAccess: hasVideoAccess(user.email),
    },
  };
}
