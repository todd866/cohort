export interface PersonalDeck {
  slug: string;
  name: string;
  shortName: string;
  label: string;
  color: string;
  weeks: number;
  ownerEmail: string;
  examDate: string | null;
  blendShare: number;
  floor?: number;
  burst?: number;
  windowDays?: number;
  burstDays?: number;
  retiredAt?: string;
}

export const PERSONAL_DECKS: PersonalDeck[] = [];

const normalizeEmail = (email: string | null | undefined) =>
  (email ?? '').trim().toLowerCase();

export function personalDeckSlugs(decks: PersonalDeck[] = PERSONAL_DECKS): string[] {
  return decks.map((deck) => deck.slug);
}

export function personalDeckLabels(
  decks: PersonalDeck[] = PERSONAL_DECKS,
): Record<string, string> {
  return Object.fromEntries(decks.map((deck) => [deck.slug, deck.label]));
}

export function personalDeckOwnerEmails(
  decks: PersonalDeck[] = PERSONAL_DECKS,
): Record<string, ReadonlySet<string>> {
  return Object.fromEntries(
    decks.map((deck) => [deck.slug, new Set([normalizeEmail(deck.ownerEmail)])]),
  );
}

export function deckForSlug(
  slug: string,
  decks: PersonalDeck[] = PERSONAL_DECKS,
): PersonalDeck | undefined {
  return decks.find((deck) => deck.slug === slug);
}

export function ownedActiveDecks(
  email: string | null | undefined,
  today: Date,
  decks: PersonalDeck[] = PERSONAL_DECKS,
): PersonalDeck[] {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return [];
  const timestamp = today.getTime();
  return decks.filter((deck) => {
    if (normalizeEmail(deck.ownerEmail) !== normalizedEmail) return false;
    if (deck.retiredAt && timestamp >= Date.parse(`${deck.retiredAt}T00:00:00Z`)) return false;
    if (deck.examDate && timestamp >= Date.parse(`${deck.examDate}T00:00:00Z`)) return false;
    return true;
  });
}
