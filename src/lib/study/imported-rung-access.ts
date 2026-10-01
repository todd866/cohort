/**
 * Imported hard rungs: AnKing and Malleus cards promoted into a native
 * rotation, served to copyright-tier viewers only.
 *
 * Requested 2026-09-14: harder questions mined from the imported decks, served
 * to the copyright tier only.
 *
 * A rotation can hold plenty of cards and still have almost no hard rungs — the
 * paediatrics corpus sits at under a third of its complexity-3 floor. The
 * imported decks are an order of magnitude larger, already embedded, and
 * already rights-cleared for that tier, so nearest-neighbour search over
 * vectors we have already paid for beats authoring from nothing.
 *
 * THE GATE IS DERIVED FROM PROVENANCE, NOT STAMPED ON THE CARD. A promoted card
 * keeps its own `rotation` ('anking' / 'malleus') and merely declares the host
 * slug in `moduleNodes` — the same authored-once-appears-in-many-views
 * mechanism the anatomy trio uses. So "is this card rights-restricted?" is
 * answered by where it came from, which cannot drift out of sync with a
 * separate boolean somebody forgets to set on the next import. Adding a flag
 * would create exactly the two-sources-of-truth problem that a re-seed breaks.
 *
 * WHY NOT BLEND THE DECK. The obvious move is to add the imported decks as
 * COMPANION_SOURCES for the host rotation. That is wrong twice. That module's
 * own comment forbids it — "Never add a personal deck here" — because a
 * companion pairing would bypass the owner allow-list. And it would grant a
 * whole deck of tens of thousands of cards when what was asked for was harder
 * questions on specific concepts.
 *
 * The distinction that carries the design is a DECK grant versus a CONTENT
 * grant. The learners reached here are not enrolled in the source decks and
 * cannot browse them; they can be served a specific reviewed card that has been
 * promoted onto a concept in the rotation they ARE studying.
 */

/**
 * Rights-restricted source corpora. A card originating here is never served to
 * a standard-tier viewer, however it was promoted.
 */
const RESTRICTED_SOURCE_ROTATIONS: ReadonlySet<string> = new Set(['anking', 'malleus']);

export interface ImportedRungCard {
  rotation: string | null | undefined;
  moduleNodes?: readonly string[] | null;
}

/**
 * The marker a REVIEWED promotion sets.
 *
 * The host slug itself cannot be used and finding out why was the whole lesson:
 * the Malleus import already stamps every card with
 * ["malleus","critical-care","cah","paam","pwh"] — a catch-all covering every
 * rotation it might ever be relevant to. Gating on `moduleNodes has 'cah'`
 * therefore admitted 3,347 Malleus cards, not the 16 that had been reviewed,
 * and I had written in a commit message that the bound was "the reviewed set,
 * not the corpus". It was not. A verification query after applying is what
 * caught it.
 *
 * A dedicated namespaced marker cannot collide with an importer's catch-all,
 * because nothing sets it except the promotion script.
 */
export function hardRungMarker(hostRotation: string): string {
  return `hard-rung:${hostRotation}`;
}

/** Is this card a promoted rung rather than a native card of `hostRotation`? */
export function isImportedRung(card: ImportedRungCard, hostRotation: string): boolean {
  const source = card.rotation ?? '';
  if (!RESTRICTED_SOURCE_ROTATIONS.has(source)) return false;
  if (source === hostRotation) return false;
  return (card.moduleNodes ?? []).includes(hardRungMarker(hostRotation));
}

/** Does serving this card in `hostRotation` require the copyright tier? */
export function requiresCopyrightTier(card: ImportedRungCard, hostRotation: string): boolean {
  return isImportedRung(card, hostRotation);
}

/**
 * The serving predicate. Fails CLOSED: an absent or unrecognised tier denies,
 * so a call site that forgets to thread the tier through withholds restricted
 * content rather than leaking it. That direction matters more than convenience
 * — the failure it prevents is distributing licensed material.
 */
export function viewerMayServeImportedRung(
  card: ImportedRungCard,
  hostRotation: string,
  imageTier: string | null | undefined,
): boolean {
  if (!requiresCopyrightTier(card, hostRotation)) return true;
  return imageTier === 'copyright';
}
