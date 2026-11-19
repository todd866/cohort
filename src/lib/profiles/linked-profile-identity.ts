/**
 * Client-safe identity markers for linked learner profiles.
 *
 * A linked profile is its own `User` row (own progress, events, chats and
 * voice records) owned by a parent account through `User.parentUserId`. It has
 * no credentials: its email sits in a reserved `.invalid` domain (RFC 2606), so
 * no email link or OAuth provider can ever sign in to it, and it is reached only
 * by the parent switching to it (linked-profile.server.ts).
 *
 * The reserved domain doubles as the access signal the deck predicates read,
 * because they reason over a viewer's emails. Nothing a learner controls can
 * produce it: aliases need a delivered verification email, and `.invalid`
 * never delivers.
 */

export const LINKED_PROFILE_EMAIL_DOMAIN = 'linked-profile.md3.invalid';

export function linkedProfileEmail(profileUserId: string): string {
  return `profile-${profileUserId.toLowerCase()}@${LINKED_PROFILE_EMAIL_DOMAIN}`;
}

export function isLinkedProfileEmail(email: string | null | undefined): boolean {
  const normalized = (email ?? '').trim().toLowerCase();
  return normalized.endsWith(`@${LINKED_PROFILE_EMAIL_DOMAIN}`) && normalized.length > LINKED_PROFILE_EMAIL_DOMAIN.length + 1;
}

export function viewerIsLinkedProfile(emails: readonly (string | null | undefined)[]): boolean {
  return emails.some(isLinkedProfileEmail);
}

/** What the session tells the client while a linked profile is active. */
export interface ActiveProfileMarker {
  kind: string;
  /** The signed-in account that switched to this profile. */
  accountId: string;
  /** What the interface calls this profile; chosen on the server. */
  label: string;
  /** Where this profile talks to an assistant instead of in-app AI, if anywhere. */
  talkElsewhere?: string;
}
