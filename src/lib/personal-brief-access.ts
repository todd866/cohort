import type { CourseBrief } from './personal-brief';

/**
 * Authorization for a personal brief is bound to the immutable database user
 * id. Email addresses and aliases are mutable profile data and are never an
 * authorization signal for this dossier.
 */
export function userIdOwnsBrief(
  brief: Pick<CourseBrief, 'ownerUserId'>,
  userId: string | null | undefined,
): boolean {
  return !!userId && !!brief.ownerUserId && userId === brief.ownerUserId;
}
