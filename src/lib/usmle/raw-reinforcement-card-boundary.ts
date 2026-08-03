import type { Prisma } from '@prisma/client';
import { USMLE_STEP1_PUBLIC_MODULE } from './public-corpus';
import {
  rawPublicUsmleQuestionWhere,
  USMLE_STEP1_PRIMARY_ROTATION,
} from './raw-question-boundary';

export const QUESTION_REINFORCEMENT_SOURCE_COMPONENT = 'QuestionReinforcement' as const;

/**
 * Keep answer-bearing reinforcement cards derived from public Step 1 questions
 * out of legacy Card transports.
 *
 * The linked Question is the canonical identity. Card-level routing markers
 * are included as defense in depth for legacy rows whose relation has drifted.
 * Every exclusion is scoped to QuestionReinforcement so authored cards in a
 * USMLE rotation are not hidden by this raw-question delivery boundary.
 */
export function withoutRawPublicUsmleReinforcementCards(
  where: Prisma.CardWhereInput,
): Prisma.CardWhereInput {
  return {
    AND: [
      where,
      {
        NOT: {
          sourceComponent: QUESTION_REINFORCEMENT_SOURCE_COMPONENT,
          rotation: USMLE_STEP1_PRIMARY_ROTATION,
        },
      },
      {
        NOT: {
          sourceComponent: QUESTION_REINFORCEMENT_SOURCE_COMPONENT,
          moduleNodes: { has: USMLE_STEP1_PUBLIC_MODULE },
        },
      },
      {
        NOT: {
          sourceComponent: QUESTION_REINFORCEMENT_SOURCE_COMPONENT,
          question: { is: rawPublicUsmleQuestionWhere() },
        },
      },
    ],
  };
}
