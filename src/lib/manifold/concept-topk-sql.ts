/**
 * The item-eligibility predicates of the scheduler's concept top-K, shared by
 * the live query (bulk-candidates → scoreItemsAgainstConceptsTopK) and the
 * precompute (concept-topk-refresh). One definition, so the two cannot drift:
 * the precompute is only valid while it ranks the same set of items as the live
 * query.
 *
 * Every fragment refers to the parent row as `p`, the alias the scoring query
 * gives "Card" / "Question".
 */

import { Prisma } from '@prisma/client';
import { USMLE_STEP1_ROTATIONS } from '@/lib/usmle/raw-question-boundary';
import { USMLE_STEP1_PUBLIC_MODULE } from '@/lib/usmle/public-corpus';

/** Cards the scheduler may rank at all: not soft-deleted, not parked. */
export const CARD_TOPK_ELIGIBILITY_SQL = Prisma.sql`p."deletedAt" IS NULL AND p."shelvedAt" IS NULL`;

/** Questions the scheduler may rank: not shelved, not raw public USMLE material. */
export const QUESTION_TOPK_ELIGIBILITY_SQL = Prisma.sql`p."contentState" <> 'shelved'
  AND p.rotation NOT IN (${Prisma.join([...USMLE_STEP1_ROTATIONS])})
  AND (
    p."moduleNodes" IS NULL
    OR NOT (${USMLE_STEP1_PUBLIC_MODULE} = ANY(p."moduleNodes"))
  )`;

/** The learner's practice locale: items with no locale, plus that locale. */
export function practiceLocaleTopKSql(practiceLocale: string): Prisma.Sql {
  return Prisma.sql`(p."practiceLocale" IS NULL OR p."practiceLocale" = ${practiceLocale})`;
}
