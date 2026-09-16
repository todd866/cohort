import type { Prisma } from '@prisma/client';
import { USMLE_STEP1_PUBLIC_MODULE } from './public-corpus';
import { CHECKED_IN_OPEN_USMLE_RELEASE_IDS } from './public-release-bundle';

/**
 * The private Step 1 study material (the `content/usmle/step1` cards and the
 * private pearls bank). Registered as a personal deck, never distributed.
 */
export const USMLE_STEP1_PRIMARY_ROTATION = 'usmle-step1' as const;

/**
 * The open Step 1 corpus cohort.md serves — MIT/CC-BY, in the FOSS
 * distribution, answerable by anonymous visitors.
 *
 * These used to share `usmle-step1` with the private material above, which made
 * a single slug mean both "public product" and "personal deck". The personal
 * flag was then the only thing holding the two apart, so the ownership gate that
 * protects the private half also rejected every guest answering the public half.
 */
export const USMLE_STEP1_OPEN_ROTATION = 'usmle-step1-open' as const;

/** Both halves of Step 1, for containment checks that must span the split. */
export const USMLE_STEP1_ROTATIONS = [
  USMLE_STEP1_PRIMARY_ROTATION,
  USMLE_STEP1_OPEN_ROTATION,
] as const;

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
    || (typeof question.rotation === 'string'
      && (USMLE_STEP1_ROTATIONS as readonly string[]).includes(question.rotation))
    || question.moduleNodes?.includes(USMLE_STEP1_PUBLIC_MODULE) === true;
}

/** Canonical positive membership predicate for database-backed lineage checks. */
export function rawPublicUsmleQuestionWhere(): Prisma.QuestionWhereInput {
  return {
    OR: [
      { id: { in: [...CHECKED_IN_OPEN_USMLE_RELEASE_IDS] } },
      { rotation: { in: [...USMLE_STEP1_ROTATIONS] } },
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
      { NOT: { rotation: { in: [...USMLE_STEP1_ROTATIONS] } } },
      { NOT: { moduleNodes: { has: USMLE_STEP1_PUBLIC_MODULE } } },
    ],
  };
}
