import { prisma } from '@/lib/prisma';

export const MIN_ATTEMPTS_FOR_DIFFICULTY_CALIBRATION = 20;

export function calibrateDifficultyFromFacilityIndex(
  facilityIndex: number
): 'easy' | 'medium' | 'hard' {
  if (facilityIndex >= 0.7) return 'easy';
  if (facilityIndex >= 0.4) return 'medium';
  return 'hard';
}

export async function updateQuestionAnalytics(
  questionId: string,
  options?: {
    minAttemptsForDifficulty?: number;
    /**
     * Public release items bind authored difficulty into their checked-in
     * serving fingerprint. Their pooled facility telemetry must therefore not
     * rewrite that authored field and invalidate the release at runtime.
     */
    calibrateDifficulty?: boolean;
  }
): Promise<void> {
  const minAttempts =
    options?.minAttemptsForDifficulty ?? MIN_ATTEMPTS_FOR_DIFFICULTY_CALIBRATION;

  const [totalAttempts, totalCorrect] = await Promise.all([
    prisma.questionResponse.count({ where: { questionId } }),
    prisma.questionResponse.count({ where: { questionId, isCorrect: true } }),
  ]);

  const facilityIndex = totalAttempts > 0 ? totalCorrect / totalAttempts : null;

  const updateData: Record<string, unknown> = {
    totalAttempts,
    facilityIndex,
  };

  if (
    options?.calibrateDifficulty !== false
    && typeof facilityIndex === 'number'
    && totalAttempts >= minAttempts
  ) {
    updateData.difficulty = calibrateDifficultyFromFacilityIndex(facilityIndex);
  }

  await prisma.question.update({
    where: { id: questionId },
    data: updateData,
  });
}
