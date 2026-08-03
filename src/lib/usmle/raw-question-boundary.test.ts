import { describe, expect, it } from 'vitest';
import {
  isRawPublicUsmleQuestionIdentity,
  rawPublicUsmleQuestionWhere,
  withoutRawPublicUsmleQuestions,
} from './raw-question-boundary';
import { CHECKED_IN_OPEN_USMLE_RELEASE_IDS } from './public-release-bundle';

const releasedQuestionIds = [...CHECKED_IN_OPEN_USMLE_RELEASE_IDS];

describe('withoutRawPublicUsmleQuestions', () => {
  it('defines canonical protected membership from either routing marker', () => {
    expect(rawPublicUsmleQuestionWhere()).toEqual({
      OR: [
        { id: { in: releasedQuestionIds } },
        { rotation: 'usmle-step1' },
        { moduleNodes: { has: 'usmle/step1' } },
      ],
    });
  });

  it('excludes both primary-rotation and cross-listed public Step 1 rows', () => {
    expect(withoutRawPublicUsmleQuestions({ id: 'question-id' })).toEqual({
      AND: [
        { id: 'question-id' },
        { NOT: { id: { in: releasedQuestionIds } } },
        { NOT: { rotation: 'usmle-step1' } },
        { NOT: { moduleNodes: { has: 'usmle/step1' } } },
      ],
    });
  });

  it.each([
    [{ id: releasedQuestionIds[0], rotation: 'critical-care', moduleNodes: [] }, true],
    [{ rotation: 'usmle-step1', moduleNodes: [] }, true],
    [{ rotation: 'critical-care', moduleNodes: ['usmle/step1'] }, true],
    [{ rotation: 'critical-care', moduleNodes: ['shared/ecg'] }, false],
  ])('identifies protected rows from either routing marker', (question, expected) => {
    expect(isRawPublicUsmleQuestionIdentity(question)).toBe(expected);
  });
});
