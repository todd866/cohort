import type { Prisma } from '@prisma/client';
import { USMLE_STEP1_PUBLIC_MODULE } from './public-corpus';
import { CHECKED_IN_OPEN_USMLE_RELEASE_IDS } from './public-release-bundle';

export const USMLE_STEP1_PRIMARY_ROTATION = 'usmle-step1' as const;

export interface RawPublicUsmleQuestionIdentity {
  id?: string | null;
  rotation?: string | null;
  moduleNodes?: readonly string[] | null;
}

/**
 * Runtime companion to the Prisma boundary below. This is used at write and
 * cache boundaries where a fully materialized question is already in hand.
 */
export function isRawPublicUsmleQuestionIdentity(
  question: RawPublicUsmleQuestionIdentity,
): boolean {
  return (typeof question.id === 'string' && CHECKED_IN_OPEN_USMLE_RELEASE_IDS.has(question.id))
    || question.rotation === USMLE_STEP1_PRIMARY_ROTATION
    || question.moduleNodes?.includes(USMLE_STEP1_PUBLIC_MODULE) === true;
}

/** Canonical positive membership predicate for database-backed lineage checks. */
export function rawPublicUsmleQuestionWhere(): Prisma.QuestionWhereInput {
  return {
    OR: [
      { id: { in: [...CHECKED_IN_OPEN_USMLE_RELEASE_IDS] } },
      { rotation: USMLE_STEP1_PRIMARY_ROTATION },
      { moduleNodes: { has: USMLE_STEP1_PUBLIC_MODULE } },
    ],
  };
}

/**
 * Keep public Step 1 members out of legacy transports that serialize raw
 * answer-bearing Question rows. Those items may be delivered only through the
 * opaque `/api/usmle/step1/session` then post-grade reveal contract.
 *
 * Check both primary rotation and cross-list membership: either can identify
 * a public-USMLE item, and relying on one would leave the other as a bypass.
 */
export function withoutRawPublicUsmleQuestions(
  where: Prisma.QuestionWhereInput,
): Prisma.QuestionWhereInput {
  return {
    AND: [
      where,
      { NOT: { id: { in: [...CHECKED_IN_OPEN_USMLE_RELEASE_IDS] } } },
      { NOT: { rotation: USMLE_STEP1_PRIMARY_ROTATION } },
      { NOT: { moduleNodes: { has: USMLE_STEP1_PUBLIC_MODULE } } },
    ],
  };
}
