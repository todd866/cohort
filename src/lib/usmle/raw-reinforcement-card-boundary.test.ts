import { describe, expect, it } from 'vitest';
import { withoutRawPublicUsmleReinforcementCards } from './raw-reinforcement-card-boundary';
import { CHECKED_IN_OPEN_USMLE_RELEASE_IDS } from './public-release-bundle';

const releasedQuestionIds = [...CHECKED_IN_OPEN_USMLE_RELEASE_IDS];

describe('withoutRawPublicUsmleReinforcementCards', () => {
  it('excludes reinforcement cards identified by card or canonical parent-question routing', () => {
    expect(withoutRawPublicUsmleReinforcementCards({ id: 'card-id' })).toEqual({
      AND: [
        { id: 'card-id' },
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
    });
  });

  it('scopes each exclusion to reinforcement cards so authored USMLE cards remain serveable', () => {
    const boundary = withoutRawPublicUsmleReinforcementCards({ deletedAt: null });
    const exclusions = (boundary.AND as Array<Record<string, unknown>>).slice(1);

    expect(exclusions).toHaveLength(3);
    for (const exclusion of exclusions) {
      expect(exclusion).toMatchObject({
        NOT: { sourceComponent: 'QuestionReinforcement' },
      });
    }
  });
});
