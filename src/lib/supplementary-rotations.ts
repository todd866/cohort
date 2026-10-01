/**
 * The canonical cross-rotation supplementary decks.
 *
 * A dependency-free leaf, deliberately. `rotations.ts` cannot be the home for
 * this: it reaches Prisma via getExamDateForUser, which makes it unimportable
 * from the client bundle AND absent from the FOSS distribution subset. Two
 * consumers already needed the list and could not have it —
 * `study/in-play-rotations.ts` hand-copied it (guarded by a drift test), and
 * `knowledge/session-candidate-scope.ts` broke the FOSS build by importing it.
 *
 * So the list lives here, with nothing imported, and `rotations.ts` re-exports
 * it for existing callers. One definition, no copies, reachable from anywhere.
 *
 * Supplementary = real content any signed-in user can opt into, supporting
 * whatever block is running rather than being a block with an exam of its own.
 * Not owner-gated (that is PERSONAL_DECKS) and not a scheduled rotation.
 */
export const SUPPLEMENTARY_ROTATION_IDS = ['anatomy', 'malleus'] as const;

export type SupplementaryRotationId = (typeof SUPPLEMENTARY_ROTATION_IDS)[number];

export function isSupplementaryRotation(slug: string): boolean {
  return (SUPPLEMENTARY_ROTATION_IDS as readonly string[]).includes(slug);
}
