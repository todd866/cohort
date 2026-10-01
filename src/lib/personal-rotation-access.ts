import { prisma } from '@/lib/prisma';
import { personalDeckSlugs } from '@/lib/personal-decks';
import {
  personalDeckOwnerEmails,
  personalDeckSharedAccessTier,
} from '@/lib/personal-deck-owners.server';
import { isExamCrossSourceRotation } from '@/lib/cross-source-rotations';

export type PersonalRotationId = string;

const PERSONAL_ROTATIONS = new Set<string>(personalDeckSlugs());

// Personal deck ownership is an authorization decision, not enrollment state.
// Kept in the server-only owner registry so neither client bundles nor a
// client-writable User.activeModules value can grant or disclose access.
const OWNER_EMAILS: Record<string, ReadonlySet<string>> = personalDeckOwnerEmails();

export function isPersonalRotation(rotation: string): rotation is PersonalRotationId {
  return PERSONAL_ROTATIONS.has(rotation);
}

/**
 * Everything the predicate may consider about the requester. `imageTier` is
 * required (not optional) on purpose: every call site must decide where its
 * tier signal comes from, or explicitly pass null to deny shared-tier access.
 * Owner emails always work regardless of tier.
 */
export interface PersonalRotationViewer {
  emails: readonly (string | null | undefined)[];
  imageTier: string | null | undefined;
}

const normalizeEmail = (email: string | null | undefined) =>
  (email ?? '').trim().toLowerCase();

export function viewerCanAccessPersonalRotation(
  rotation: string,
  viewer: PersonalRotationViewer,
): boolean {
  if (!isPersonalRotation(rotation)) return true;
  const owners = OWNER_EMAILS[rotation];
  const isOwner = viewer.emails.some((email) => {
    const normalized = normalizeEmail(email);
    return normalized.length > 0 && owners.has(normalized);
  });
  if (isOwner) return true;
  const sharedTier = personalDeckSharedAccessTier(rotation);
  if (sharedTier === 'signed-in') {
    return viewer.emails.some((email) => normalizeEmail(email).length > 0);
  }
  return sharedTier !== undefined && viewer.imageTier === sharedTier;
}

export function viewerCanAccessRequestedRotations(
  rotations: readonly string[],
  viewer: PersonalRotationViewer,
): boolean {
  const personal = rotations.filter(isPersonalRotation);
  if (personal.length === 0) return true;
  return personal.every((rotation) => viewerCanAccessPersonalRotation(rotation, viewer));
}

/**
 * The personal rotations this viewer may NOT access — the correct `notIn`
 * exclusion for aggregate queries. Per-rotation semantics: a viewer entitled
 * to a shared-tier deck but not the owner-only decks is excluded from exactly
 * the owner-only decks. "Can you access EVERY personal deck?" is the wrong
 * question for these filters — it silently drops entitled decks too.
 */
export function viewerInaccessiblePersonalRotations(
  viewer: PersonalRotationViewer,
): string[] {
  return [...PERSONAL_ROTATIONS].filter(
    (rotation) => !viewerCanAccessPersonalRotation(rotation, viewer),
  );
}

/**
 * DB-resolving variant of {@link viewerInaccessiblePersonalRotations}.
 * Guests and lookup failures exclude every personal rotation (fail closed);
 * returns [] when the user may access all of them.
 */
export async function userIdInaccessiblePersonalRotations(
  userId: string | null | undefined,
): Promise<string[]> {
  if (!userId) return [...PERSONAL_ROTATIONS];
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        emailAliases: {
          where: { verified: true },
          select: { email: true, verified: true },
        },
        activeModules: true,
        imageTier: true,
      },
    });
    if (!user) return [...PERSONAL_ROTATIONS];
    return viewerInaccessiblePersonalRotations({
      emails: [
        user.email,
        ...(user.emailAliases ?? [])
          .filter((alias) => alias.verified)
          .map((alias) => alias.email),
      ],
      imageTier: user.imageTier ?? null,
    });
  } catch {
    return [...PERSONAL_ROTATIONS];
  }
}

/**
 * Resolve an authenticated user to the immutable owner allowlist plus any
 * per-deck shared-tier grant. Missing users, lookup failures, and guests fail
 * closed.
 */
export async function userIdCanAccessRequestedRotations(
  userId: string | null | undefined,
  rotations: readonly string[],
): Promise<boolean> {
  const enrolledSources = rotations.filter(isExamCrossSourceRotation);
  const personal = rotations.filter(isPersonalRotation);
  if (personal.length === 0 && enrolledSources.length === 0) return true;
  if (!userId) return false;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        // Aliases are client-created before an email-link round trip. Only a
        // verified alias is an immutable identity signal suitable for access
        // control; an unverified row is merely a pending claim.
        emailAliases: {
          where: { verified: true },
          select: { email: true, verified: true },
        },
        activeModules: true,
        imageTier: true,
      },
    });
    if (!user) return false;
    // Automatic exam-support sources are opt-in partitions. Immutable owner
    // identity alone cannot make one appear in feeds after enrollment is
    // removed; non-personal sources such as Anatomy follow the same rule.
    if (!enrolledSources.every((rotation) => user.activeModules.includes(rotation))) {
      return false;
    }
    return viewerCanAccessRequestedRotations(personal, {
      emails: [
        user.email,
        ...(user.emailAliases ?? [])
          .filter((alias) => alias.verified)
          .map((alias) => alias.email),
      ],
      imageTier: user.imageTier ?? null,
    });
  } catch {
    return false;
  }
}
