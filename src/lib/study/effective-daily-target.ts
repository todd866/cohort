/**
 * Resolve today's exam commitment.
 *
 * Prefer the adaptive coverage/pace estimate (history + unseen + days to exam).
 * Fall back to `User.studyGoal` only when adaptive cannot be computed.
 */
export function effectiveExamDailyTarget(input: {
  adaptive: number | null | undefined;
  studyGoal: number | null | undefined;
}): number | null {
  if (Number.isSafeInteger(input.adaptive) && input.adaptive! > 0) {
    return input.adaptive!;
  }
  if (Number.isSafeInteger(input.studyGoal) && input.studyGoal! > 0) {
    return input.studyGoal!;
  }
  return null;
}
