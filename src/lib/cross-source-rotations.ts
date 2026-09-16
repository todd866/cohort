/**
 * Legacy content partitions that may support a user's current exam without
 * becoming exam objectives themselves.
 *
 * This is only an eligibility allow-list. A source is usable in a session
 * only when the signed-in user is entitled/enrolled AND the individual item
 * explicitly lists the current exam in `moduleNodes`.
 */
export const EXAM_CROSS_SOURCE_ROTATION_IDS = [
  'anatomy',
  // The GSSE plate corpus, and the Kubie neuroanatomy laboratory collection.
  //
  // Omitted until 2026-09-14, which made NSx — a COMPOSED deck that owns no
  // cards and can therefore only ever serve cross-source items — unable to see
  // 4,063 of the 5,102 cards that name `neurosurg` in moduleNodes. Its own
  // definition calls it "a VIEW over the plate corpus and BlueLink"; BlueLink
  // was listed here and the plate corpus was not, so 80% of the deck was
  // unreachable while every health check stayed green. The cards seeded,
  // embedded and clustered; they simply never entered a candidate pool, and
  // ServeDecision held zero rows for them.
  'surgical-sciences',
  // The native NSx corpus (the Kubie neuroanatomy laboratory and the
  // hand-authored NSx files, moved out of surgical-sciences 2026-09-16). Every
  // Kubie card also declares surgical-sciences and anatomy, so GSSE and the
  // Anatomy view borrow it back through the same per-card gate.
  'neurosurg',
  'malleus',
  'anking',
] as const;

export type ExamCrossSourceRotationId =
  (typeof EXAM_CROSS_SOURCE_ROTATION_IDS)[number];

export function isExamCrossSourceRotation(
  rotation: string,
): rotation is ExamCrossSourceRotationId {
  return (EXAM_CROSS_SOURCE_ROTATION_IDS as readonly string[]).includes(rotation);
}
