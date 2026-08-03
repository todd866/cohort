import type { Prisma } from '@prisma/client';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import {
  QUESTION_REINFORCEMENT_SOURCE_COMPONENT,
  withoutRawPublicUsmleReinforcementCards,
} from './raw-reinforcement-card-boundary';
import { withoutRawPublicUsmleQuestions } from './raw-question-boundary';

type BoundaryCardRow = {
  id: string;
  stableId: string | null;
  sourceComponent: string;
  question: { id: string } | null;
};

export interface ReinforcementCardBoundaryClient {
  card: {
    findMany(args: {
      where: Prisma.CardWhereInput;
      select: {
        id: true;
        stableId: true;
        sourceComponent: true;
        question: { select: { id: true } };
      };
    }): Promise<BoundaryCardRow[]>;
  };
  question: {
    findMany(args: {
      where: Prisma.QuestionWhereInput;
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
}

const DEFAULT_BOUNDARY_CLIENT = prisma as unknown as ReinforcementCardBoundaryClient;
const REINFORCEMENT_STABLE_ID_PREFIX = 'qcard:';
const FACT_SUFFIX_MARKER = ':fact:';

/**
 * Resolve the canonical parent encoded by deterministic reinforcement stable
 * IDs. Fact siblings have no Question.cardId relation, so this lineage is a
 * required part of the delivery boundary rather than optional metadata.
 */
export function reinforcementParentQuestionIdFromStableId(
  stableId: string | null | undefined,
): string | null {
  if (!stableId?.startsWith(REINFORCEMENT_STABLE_ID_PREFIX)) return null;
  const remainder = stableId.slice(REINFORCEMENT_STABLE_ID_PREFIX.length);
  const factMarkerIndex = remainder.indexOf(FACT_SUFFIX_MARKER);
  const parentId = factMarkerIndex >= 0
    ? remainder.slice(0, factMarkerIndex)
    : remainder;
  return parentId.trim().length > 0 ? parentId : null;
}

/**
 * Return the card IDs that may cross a legacy answer-bearing Card transport.
 *
 * This performs two current-database checks:
 * 1. direct Card markers and the linked parent relation;
 * 2. the parent encoded in `qcard:<questionId>[:fact:*]` stable IDs.
 *
 * A QuestionReinforcement row is deliverable only when every available parent
 * identity resolves to an existing, non-protected Question. Missing or
 * malformed lineage fails closed. Ordinary authored cards are unaffected.
 */
export async function resolveDeliverableReinforcementCardIds(
  cardIds: readonly string[],
  client: ReinforcementCardBoundaryClient = DEFAULT_BOUNDARY_CLIENT,
): Promise<Set<string>> {
  const uniqueIds = [...new Set(cardIds.filter((id) => id.trim().length > 0))];
  if (uniqueIds.length === 0) return new Set();

  const cards = await client.card.findMany({
    where: withoutRawPublicUsmleReinforcementCards({ id: { in: uniqueIds } }),
    select: {
      id: true,
      stableId: true,
      sourceComponent: true,
      question: { select: { id: true } },
    },
  });

  const reinforcementParentIds = new Map<string, Set<string>>();
  for (const card of cards) {
    // `qcard:` is a reserved deterministic namespace, not merely optional
    // metadata. Treat it as reinforcement identity even if sourceComponent
    // has drifted, otherwise a relationless legacy fact sibling could become
    // an ordinary card simply by losing one label.
    const hasReservedStableId = card.stableId?.startsWith(REINFORCEMENT_STABLE_ID_PREFIX) ?? false;
    if (
      card.sourceComponent !== QUESTION_REINFORCEMENT_SOURCE_COMPONENT
      && !hasReservedStableId
    ) continue;
    const parentIds = new Set<string>();
    if (card.question?.id) parentIds.add(card.question.id);
    const stableParentId = reinforcementParentQuestionIdFromStableId(card.stableId);
    if (stableParentId) parentIds.add(stableParentId);
    reinforcementParentIds.set(card.id, parentIds);
  }

  const allParentIds = [...new Set(
    [...reinforcementParentIds.values()].flatMap((ids) => [...ids]),
  )];
  const safeParentRows = allParentIds.length > 0
    ? await client.question.findMany({
        where: withoutRawPublicUsmleQuestions({ id: { in: allParentIds } }),
        select: { id: true },
      })
    : [];
  const safeParentIds = new Set(safeParentRows.map((row) => row.id));

  return new Set(cards.flatMap((card) => {
    const isReinforcement =
      card.sourceComponent === QUESTION_REINFORCEMENT_SOURCE_COMPONENT
      || card.stableId?.startsWith(REINFORCEMENT_STABLE_ID_PREFIX) === true;
    if (!isReinforcement) {
      return [card.id];
    }
    const parentIds = reinforcementParentIds.get(card.id);
    if (!parentIds || parentIds.size === 0) return [];
    return [...parentIds].every((id) => safeParentIds.has(id)) ? [card.id] : [];
  }));
}

/** Fail-closed convenience wrapper for transport rows. */
export async function filterDeliverableReinforcementCardRows<T extends { id: string }>(
  rows: readonly T[],
  options: {
    client?: ReinforcementCardBoundaryClient;
    logContext?: Record<string, unknown>;
  } = {},
): Promise<T[]> {
  if (rows.length === 0) return [];
  try {
    const deliverableIds = await resolveDeliverableReinforcementCardIds(
      rows.map((row) => row.id),
      options.client ?? DEFAULT_BOUNDARY_CLIENT,
    );
    return rows.filter((row) => deliverableIds.has(row.id));
  } catch (error) {
    logger.error('Reinforcement card lineage lookup failed; dropping candidate cards', {
      candidateCount: rows.length,
      error: error instanceof Error ? error.message : String(error),
      ...options.logContext,
    });
    return [];
  }
}
