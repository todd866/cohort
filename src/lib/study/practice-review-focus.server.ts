import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import {
  buildPracticeReviewFocusFromAttempts,
  parsePracticeReviewFocus,
  type PracticeReviewFocus,
  type PracticeReviewPaper,
  type PracticeReviewPaperReference,
  type PracticeReviewSubmittedAttempt,
} from './practice-review-focus';
export { practiceReviewPaperVersion } from './practice-paper-version.server';

export const PRACTICE_REVIEW_HISTORY_LIMIT = 20;

/**
 * Only call while submitting an attempt, before its creation in this transaction.
 * The row lock serializes a learner's submissions; session preparation must keep
 * using loadPracticeReviewFocus and never read these historical attempts.
 */
export async function buildPracticeReviewFocusForSubmission(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userId: string,
  paper: PracticeReviewPaper,
  reference: PracticeReviewPaperReference,
  answers: readonly (number | null)[],
  submittedAt: Date,
  attemptId = '',
): Promise<{ reviewFocus: PracticeReviewFocus | null; paperReference: PracticeReviewPaperReference }> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  const now = Date.now();
  const history = await tx.$queryRaw<PracticeReviewSubmittedAttempt[]>`
    SELECT "id" AS "attemptId", "paper", "answers", "submittedAt"
    FROM "ExamPaperSession"
    WHERE "userId" = ${userId}
      AND "rotation" = ${paper.rotation}
      AND "submittedAt" IS NOT NULL
      AND "paper"->>'schema' = ${reference.schema}
      AND "paper"->>'paperId' = ${reference.paperId}
      AND "paper"->>'paperVersion' = ${reference.paperVersion}
    ORDER BY "submittedAt" DESC,
      CASE WHEN jsonb_typeof("paper"->'reviewFocusSequence') = 'number' THEN
        CASE WHEN ("paper"->>'reviewFocusSequence')::numeric >= 0
          AND ("paper"->>'reviewFocusSequence')::numeric < 9007199254740991
          AND trunc(("paper"->>'reviewFocusSequence')::numeric) = ("paper"->>'reviewFocusSequence')::numeric
        THEN ("paper"->>'reviewFocusSequence')::numeric ELSE 0 END
      ELSE 0 END DESC,
      "id" ASC
    LIMIT ${PRACTICE_REVIEW_HISTORY_LIMIT}
  `;
  // Receipt order within the retained history makes equal client timestamps
  // stable on later submissions too; UUID order is not receipt order. This is
  // not a lifetime counter: attempts outside the 20-candidate window are ignored.
  const previousSequence = history.reduce((highest, attempt) => {
    const saved = attempt.paper;
    const sequence = saved && typeof saved === 'object' && !Array.isArray(saved)
      ? (saved as { reviewFocusSequence?: unknown }).reviewFocusSequence : undefined;
    return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0 && sequence < Number.MAX_SAFE_INTEGER - 1
      ? Math.max(highest, sequence) : highest;
  }, 0);
  const paperReference = {
    ...reference,
    reviewFocusSequence: previousSequence + 1,
  };
  const reviewFocus = buildPracticeReviewFocusFromAttempts(
    { ...paper, paperId: reference.paperId, paperTitle: paperReference.paperTitle, paperPath: paperReference.paperPath },
    reference,
    [...history, { paper: paperReference, answers, submittedAt, attemptId }],
    now,
  );
  return { reviewFocus, paperReference };
}

/** Write alongside the finished attempt. Atomic JSON merge preserves other feed settings. */
export async function persistPracticeReviewFocus(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  userId: string,
  focus: PracticeReviewFocus,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "User"
    SET "feedProfile" = jsonb_set(
      CASE WHEN jsonb_typeof("feedProfile") = 'object' THEN "feedProfile" ELSE '{}'::jsonb END,
      '{practiceReviewFocus}',
      (CASE WHEN jsonb_typeof("feedProfile"->'practiceReviewFocus') = 'object'
        THEN "feedProfile"->'practiceReviewFocus' ELSE '{}'::jsonb END)
        || jsonb_build_object(${focus.rotation}::text, ${JSON.stringify(focus)}::jsonb),
      true
    )
    WHERE "id" = ${userId}
      AND COALESCE("feedProfile"->'practiceReviewFocus'->${focus.rotation}->>'submittedAt', '')
        <= ${focus.submittedAt}
  `;
}

/** Request-safe: one primary-key snapshot read, never an exam/history scan. */
export async function loadPracticeReviewFocus(userId: string, rotation: string): Promise<PracticeReviewFocus | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ focus: unknown }>>`
      SELECT "feedProfile"->'practiceReviewFocus'->${rotation} AS focus
      FROM "User" WHERE "id" = ${userId}
    `;
    return parsePracticeReviewFocus({ practiceReviewFocus: { [rotation]: rows[0]?.focus } }, rotation);
  } catch (error) {
    logger.warn('practice-review-focus: optional snapshot unavailable', { error: String(error) });
    return null;
  }
}

/** Carry only valid snapshots when an anonymous learner claims an account. */
export async function claimPracticeReviewFocus(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  userId: string,
  guestProfile: unknown,
): Promise<void> {
  if (!guestProfile || typeof guestProfile !== 'object') return;
  const stored = (guestProfile as { practiceReviewFocus?: unknown }).practiceReviewFocus;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
  for (const rotation of Object.keys(stored).slice(0, 20)) {
    const focus = parsePracticeReviewFocus(guestProfile, rotation);
    if (focus) await persistPracticeReviewFocus(tx, userId, focus);
  }
}
