import { describe, expect, it, vi } from 'vitest';
import type { ReinforcementCardBoundaryClient } from './reinforcement-card-delivery';
import {
  filterDeliverableReinforcementCardRows,
  reinforcementParentQuestionIdFromStableId,
  resolveDeliverableReinforcementCardIds,
} from './reinforcement-card-delivery';
import { CHECKED_IN_OPEN_USMLE_RELEASE_IDS } from './public-release-bundle';

const releasedQuestionIds = [...CHECKED_IN_OPEN_USMLE_RELEASE_IDS];

function clientWith(options: {
  cards: Array<{
    id: string;
    stableId: string | null;
    sourceComponent: string;
    question: { id: string } | null;
  }>;
  safeParentIds?: string[];
}): ReinforcementCardBoundaryClient {
  return {
    card: { findMany: vi.fn().mockResolvedValue(options.cards) },
    question: {
      findMany: vi.fn().mockResolvedValue(
        (options.safeParentIds ?? []).map((id) => ({ id })),
      ),
    },
  };
}

describe('reinforcementParentQuestionIdFromStableId', () => {
  it.each([
    ['qcard:q-primary', 'q-primary'],
    ['qcard:q-cross:fact:fact-1', 'q-cross'],
    ['card:q-1', null],
    ['qcard:', null],
    [null, null],
  ])('resolves %j to %j', (stableId, expected) => {
    expect(reinforcementParentQuestionIdFromStableId(stableId)).toBe(expected);
  });
});

describe('resolveDeliverableReinforcementCardIds', () => {
  it('drops a relationless fact card whose stableId parent is cross-listed into protected Step 1', async () => {
    const client = clientWith({
      cards: [
        {
          id: 'relationless-fact-card',
          stableId: 'qcard:q-crosslisted:fact:fact-1',
          sourceComponent: 'QuestionReinforcement',
          question: null,
        },
        {
          id: 'ordinary-card',
          stableId: 'authored:ordinary-card',
          sourceComponent: 'KeyPoint',
          question: null,
        },
      ],
      // The protected q-crosslisted parent is intentionally absent from the
      // non-protected Question query result.
      safeParentIds: [],
    });

    const result = await resolveDeliverableReinforcementCardIds(
      ['relationless-fact-card', 'ordinary-card'],
      client,
    );

    expect([...result]).toEqual(['ordinary-card']);
    expect(client.question.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { id: { in: ['q-crosslisted'] } },
          { NOT: { id: { in: releasedQuestionIds } } },
          { NOT: { rotation: 'usmle-step1' } },
          { NOT: { moduleNodes: { has: 'usmle/step1' } } },
        ],
      },
      select: { id: true },
    });
  });

  it('keeps reinforcement only when every linked or stableId parent resolves as non-protected', async () => {
    const client = clientWith({
      cards: [
        {
          id: 'safe-primary',
          stableId: 'qcard:q-safe',
          sourceComponent: 'QuestionReinforcement',
          question: { id: 'q-safe' },
        },
        {
          id: 'mismatched-parent',
          stableId: 'qcard:q-protected',
          sourceComponent: 'QuestionReinforcement',
          question: { id: 'q-safe' },
        },
        {
          id: 'orphan',
          stableId: null,
          sourceComponent: 'QuestionReinforcement',
          question: null,
        },
      ],
      safeParentIds: ['q-safe'],
    });

    const result = await resolveDeliverableReinforcementCardIds(
      ['safe-primary', 'mismatched-parent', 'orphan'],
      client,
    );

    expect([...result]).toEqual(['safe-primary']);
  });

  it('treats the reserved qcard namespace as reinforcement when sourceComponent has drifted', async () => {
    const client = clientWith({
      cards: [
        {
          id: 'drifted-fact-card',
          stableId: 'qcard:q-protected:fact:fact-1',
          sourceComponent: 'KeyPoint',
          question: null,
        },
        {
          id: 'malformed-reserved-card',
          stableId: 'qcard:',
          sourceComponent: 'KeyPoint',
          question: null,
        },
      ],
      safeParentIds: [],
    });

    const result = await resolveDeliverableReinforcementCardIds(
      ['drifted-fact-card', 'malformed-reserved-card'],
      client,
    );

    expect([...result]).toEqual([]);
    expect(client.question.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { id: { in: ['q-protected'] } },
          { NOT: { id: { in: releasedQuestionIds } } },
          { NOT: { rotation: 'usmle-step1' } },
          { NOT: { moduleNodes: { has: 'usmle/step1' } } },
        ],
      },
      select: { id: true },
    });
  });

  it('applies the direct Card/link predicate before stableId parent resolution', async () => {
    const client = clientWith({ cards: [] });

    await resolveDeliverableReinforcementCardIds(['candidate'], client);

    expect(client.card.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { id: { in: ['candidate'] } },
          {
            NOT: {
              sourceComponent: 'QuestionReinforcement',
              rotation: 'usmle-step1',
            },
          },
          {
            NOT: {
              sourceComponent: 'QuestionReinforcement',
              moduleNodes: { has: 'usmle/step1' },
            },
          },
          {
            NOT: {
              sourceComponent: 'QuestionReinforcement',
              question: {
                is: {
                  OR: [
                    { id: { in: releasedQuestionIds } },
                    { rotation: 'usmle-step1' },
                    { moduleNodes: { has: 'usmle/step1' } },
                  ],
                },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        stableId: true,
        sourceComponent: true,
        question: { select: { id: true } },
      },
    });
  });

  it('fails closed for all candidate rows when lineage lookup errors', async () => {
    const client = clientWith({ cards: [] });
    vi.mocked(client.card.findMany).mockRejectedValue(new Error('database unavailable'));

    await expect(filterDeliverableReinforcementCardRows(
      [{ id: 'ordinary-card', back: 'answer' }],
      { client },
    )).resolves.toEqual([]);
  });
});
