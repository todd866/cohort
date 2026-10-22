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

import { effectiveInstitution } from './effective-institution';

export interface SessionPayloadUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  betaAccess: boolean;
  /**
   * The institution the learner is read as: the stored value, or 'usyd' for a
   * learner with a Year 3 stream and none recorded (effective-institution.ts).
   */
  institution: string | null;
  /** Year 3 stream (1-4), or null. */
  track: number | null;
  imageTier: 'standard' | 'copyright';
  isAdmin: boolean;
  hasVideoAccess: boolean;
  /** May talk to md3's AI (src/lib/ai-access.ts). */
  aiAccess: boolean;
  /** Clinical audiences: the current rotation (stream x block) when it offers something, and 'md1'. */
  clinicalAudiences: string[];
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
  track?: number | null;
  imageTier?: string | null;
  activeModules?: unknown;
}

/** The viewer fields the current-rotation audience is derived from. */
export interface RotationAudienceViewer {
  institution: string | null;
  track: number | null;
  imageTier: string | null;
  betaAccess: boolean;
}

/** The personal-deck entitlement check, injected so this module stays dependency-free. */
export type PersonalRotationAccessCheck = (
  rotation: string,
  viewer: { emails: readonly (string | null | undefined)[]; imageTier: string | null | undefined },
) => boolean;

/**
 * Clinical audiences.
 *
 * The rotation audience is the learner's CURRENT rotation (stream x block),
 * derived server-side by the injected `rotationAudiences` (clinical-audience.ts)
 * and passed in here. It used to be 'cah' for anyone with a CAH slug saved,
 * which outlived the block: Track 3 learners on PWH kept CAH and could not
 * reach the PWH WBA board (2026-10-22). A saved slug grants no rotation.
 *
 * 'md1' when enrolled in the MD1 KAT4 + MMCA deck (2026-10-21) AND the live
 * owner registry still grants that deck to this viewer: the saved slug alone
 * is not a grant, because it can outlive a revoked grant. Without an access
 * check the md1 audience is never given (fail closed).
 */
export function clinicalAudiencesFor(
  activeModules: unknown,
  canOpenPersonalDeck: (rotation: string) => boolean = () => false,
  rotationAudiences: readonly string[] = [],
): string[] {
  const audiences = [...new Set(rotationAudiences)];
  if (Array.isArray(activeModules)
    && activeModules.includes('md1-foundations') && canOpenPersonalDeck('md1-foundations')) {
    audiences.push('md1');
  }
  return audiences;
}

export function buildSessionPayload({
  session,
  user,
  isAdminEmail,
  hasVideoAccess,
  hasAiAccess = () => false,
  canAccessPersonalRotation,
  currentRotationAudiences,
}: {
  session: { expires: string };
  user: AdapterRow;
  isAdminEmail: (email: string | null | undefined) => boolean;
  hasVideoAccess: (email: string | null | undefined) => boolean;
  hasAiAccess?: (email: string | null | undefined) => boolean;
  /** Live personal-deck entitlement; omitted = no personal-deck audience. */
  canAccessPersonalRotation?: PersonalRotationAccessCheck;
  /** Current-rotation clinical audiences (clinical-audience.ts); omitted = none. */
  currentRotationAudiences?: (viewer: RotationAudienceViewer) => string[];
}): SessionPayload {
  const track = typeof user.track === 'number' ? user.track : null;
  return {
    expires: session.expires,
    user: {
      id: user.id,
      name: user.name ?? null,
      email: user.email ?? null,
      image: user.image ?? null,
      betaAccess: user.betaAccess ?? false,
      // A session belongs to a registered account, never a guest.
      institution: effectiveInstitution({ institution: user.institution, track, registered: true }),
      track,
      imageTier: user.imageTier === 'copyright' ? 'copyright' : 'standard',
      isAdmin: isAdminEmail(user.email),
      hasVideoAccess: hasVideoAccess(user.email),
      aiAccess: hasAiAccess(user.email),
      clinicalAudiences: clinicalAudiencesFor(
        user.activeModules,
        (rotation) => canAccessPersonalRotation?.(rotation, {
          emails: [user.email],
          imageTier: user.imageTier,
        }) ?? false,
        currentRotationAudiences?.({
          institution: user.institution ?? null,
          track,
          imageTier: user.imageTier ?? null,
          betaAccess: user.betaAccess ?? false,
        }) ?? [],
      ),
    },
  };
}
