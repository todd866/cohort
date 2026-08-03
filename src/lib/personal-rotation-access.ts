import { prisma } from '@/lib/prisma';
import { personalDeckSlugs, personalDeckOwnerEmails } from '@/lib/personal-decks';

export type PersonalRotationId = string;

const PERSONAL_ROTATIONS = new Set<string>(personalDeckSlugs());

// Personal deck ownership is an authorization decision, not enrollment state.
// Kept in server source (the PERSONAL_DECKS registry) so a client-writable
// User.activeModules value can never grant access.
const OWNER_EMAILS: Record<string, ReadonlySet<string>> = personalDeckOwnerEmails();

export function isPersonalRotation(rotation: string): rotation is PersonalRotationId {
  return PERSONAL_ROTATIONS.has(rotation);
}

export function emailCanAccessPersonalRotation(
  rotation: string,
  email: string | null | undefined,
): boolean {
  if (!isPersonalRotation(rotation)) return true;
  if (!email) return false;
  return OWNER_EMAILS[rotation].has(email.trim().toLowerCase());
}

export function emailCanAccessRequestedRotations(
  rotations: readonly string[],
  emails: readonly (string | null | undefined)[],
): boolean {
  const personal = rotations.filter(isPersonalRotation);
  if (personal.length === 0) return true;
  return personal.every((rotation) =>
    emails.some((email) => emailCanAccessPersonalRotation(rotation, email))
  );
}

/**
 * Resolve an authenticated user to the immutable owner allowlist.
 * Missing users, lookup failures, and guests fail closed.
 */
export async function userIdCanAccessRequestedRotations(
  userId: string | null | undefined,
  rotations: readonly string[],
): Promise<boolean> {
  if (!rotations.some(isPersonalRotation)) return true;
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
      },
    });
    if (!user) return false;
    return emailCanAccessRequestedRotations(
      rotations,
      [
        user.email,
        ...(user.emailAliases ?? [])
          .filter((alias) => alias.verified)
          .map((alias) => alias.email),
      ],
    );
  } catch {
    return false;
  }
}
