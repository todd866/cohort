/**
 * Which deck a single review belongs to.
 *
 * Activity used to be counted purely from `Card.rotation`, which is the card's
 * OWNING rotation and not the deck it was served into. For a composed deck that
 * owns no cards — NSx is a view over the plate corpus and BlueLink — that set is
 * empty, so the deck reported 0 reviewed while the learner was actively
 * reviewing in it, and the work was credited to `surgical-sciences` instead.
 *
 * Measured 2026-09-15: dozens of card reviews answered after being served into
 * `neurosurg` while the deck displayed 0, and Surgical Sciences displayed most
 * of the very same plates.
 *
 * Attribution is EXCLUSIVE and resolved PER REVIEW, and both halves matter.
 * Adding served-here to the owning deck's set makes a borrowed plate count once
 * under each, so the daily total counts one review twice. Resolving it over a
 * multi-day window has the same effect more subtly: a card served into anatomy
 * last week and into NSx today appears in both sets, and 6 plates double-counted
 * exactly that way on the first attempt at this fix. The deck a review belongs
 * to is the deck it was served into ON THAT DAY.
 *
 * `ServeDecision.rotation` already records that, so this needed no schema
 * change — only for the count to ask.
 */
export function attributedRotation({
  servedRotation,
  owningRotation,
}: {
  /** The deck this card was served into on the day of this review, if known. */
  servedRotation?: string | null;
  /** `Card.rotation` — the deck that owns the card. */
  owningRotation?: string | null;
}): string | null {
  // The serving deck wins. Falling back to the owner keeps every review made
  // before ServeDecision recorded a rotation counted where it always was,
  // rather than silently dropping history out of the totals.
  return servedRotation ?? owningRotation ?? null;
}

