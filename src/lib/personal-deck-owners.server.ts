import 'server-only';

import { PERSONAL_DECKS, type PersonalDeck } from '@/lib/personal-decks';

export type PersonalDeckOwnerEmails = Readonly<Record<string, ReadonlySet<string>>>;

export function personalDeckOwnerEmails(): Record<string, ReadonlySet<string>> {
  return {};
}

export function personalDeckPrimaryOwnerEmail(_slug: string): string | undefined {
  void _slug;
  return undefined;
}

export function ownedActiveDecks(
  _email: string | null | undefined,
  _today: Date,
  _decks: PersonalDeck[] = PERSONAL_DECKS,
  _ownerEmails: PersonalDeckOwnerEmails = {},
): PersonalDeck[] {
  void _email;
  void _today;
  void _decks;
  void _ownerEmails;
  return [];
}
/**
 * The public build declares no shared-tier deck grants. Present so the real
 * personal-rotation-access module compiles unchanged in the export.
 */
export function personalDeckSharedAccessTier(_slug: string): 'copyright' | undefined {
  void _slug;
  return undefined;
}
