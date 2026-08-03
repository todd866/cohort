import { describe, expect, it } from 'vitest';
import {
  auditStep1RawAnswerKey,
  step1RawAnswerKeyFailureMessages,
} from './raw-answer-key-quality';

function questionsFor(labels: string[]) {
  return labels.map((correctLabel) => ({
    options: ['A', 'B', 'C', 'D', 'E'].map((label) => ({
      label,
      text: label,
      isCorrect: label === correctLabel,
    })),
  }));
}

describe('auditStep1RawAnswerKey', () => {
  it('passes a balanced 25-item raw key without prescribing individual positions', () => {
    const audit = auditStep1RawAnswerKey(questionsFor(
      ['A', 'B', 'C', 'D', 'E'].flatMap((label) => Array(5).fill(label)),
    ));

    expect(audit).toEqual(expect.objectContaining({
      questionCount: 25,
      representedLabelCount: 5,
      maximumLabelCount: 5,
      maximumLabelShare: 0.2,
      longestSameLabelStreak: 5,
      issues: [],
    }));
  });

  it('flags the severe concentration, missing-label, and run pattern from the initial corpus', () => {
    const audit = auditStep1RawAnswerKey(questionsFor([
      ...Array(10).fill('A'),
      'C', 'B', 'D', 'C', 'B', 'C', 'B', 'A', 'D', 'D', 'B', 'A', 'C', 'A', 'A',
    ]));

    expect(audit.issues.map((issue) => issue.code)).toEqual([
      'label-coverage',
      'label-concentration',
      'label-streak',
    ]);
    expect(step1RawAnswerKeyFailureMessages(audit)).toEqual([
      'raw answer key represents 4/5 labels; 5 are required at this corpus size',
      'raw answer key puts 14/25 answers on one label; maximum share is 40%',
      'raw answer key has a 10-item same-label streak; maximum is 5',
    ]);
  });

  it('does not infer distribution defects from a sample below ten items', () => {
    const audit = auditStep1RawAnswerKey(questionsFor(Array(9).fill('A')));

    expect(audit.issues).toEqual([]);
  });
});
