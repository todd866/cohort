import { describe, expect, it } from 'vitest';
import {
  loadOpenUsmleQuestionBankFromDisk,
  USMLE_STEP1_BASELINE_V1_MODULE,
} from '@/lib/question-bank/load-seed-corpus';
import {
  checkFormatAsymmetry,
  checkLengthBias,
} from '@/lib/question-bank/validate';
import {
  analyzeGuessability,
  getGuessabilitySeverity,
} from '@/lib/manifold/option-guessability';
import {
  auditStep1RawAnswerKey,
  step1RawAnswerKeyFailureMessages,
} from './raw-answer-key-quality';

describe('checked-in open Step 1 corpus', () => {
  it('contains a self-contained, source-resolved pinned 25-item baseline', () => {
    const corpus = loadOpenUsmleQuestionBankFromDisk();

    expect(corpus.errors).toEqual([]);
    expect(corpus.questions.length).toBeGreaterThanOrEqual(25);
    expect(corpus.questions.filter((question) => (
      question.moduleNodes?.includes(USMLE_STEP1_BASELINE_V1_MODULE) === true
    ))).toHaveLength(25);
  });

  it('keeps every open item text-only and generated from an exact registered passage', () => {
    const corpus = loadOpenUsmleQuestionBankFromDisk();
    for (const question of corpus.questions) {
      expect(question.imageUrl ?? null).toBeNull();
      expect(question.publicUsmle?.origin).toBe('generated');
      expect(question.publicUsmle?.evidence.kind).toBe('passage');
      expect(question.cite).toBeTruthy();

      const evidence = question.publicUsmle?.evidence;
      if (!evidence || evidence.kind !== 'passage') throw new Error('passage evidence required');
      expect(question.cite).toBe(`${evidence.sourceId}#${evidence.passageId}`);
    }
  });

  it('retains the teaching and distractor rationale needed for useful post-answer feedback', () => {
    const corpus = loadOpenUsmleQuestionBankFromDisk();

    for (const question of corpus.questions) {
      expect(question.context).toMatch(/^Learning objective:/);
      expect(question.options).toHaveLength(5);
      for (const option of question.options) {
        expect(option.explanation?.trim().length).toBeGreaterThan(20);
        expect(option.misconception?.trim().length).toBeGreaterThan(20);
      }
    }
  });

  it('passes the same answer-form quality gates used by the seeder', () => {
    const corpus = loadOpenUsmleQuestionBankFromDisk();
    expect(checkLengthBias(corpus.questions)).toEqual([]);
    expect(checkFormatAsymmetry(corpus.questions)).toEqual([]);
    expect(step1RawAnswerKeyFailureMessages(
      auditStep1RawAnswerKey(corpus.questions),
    )).toEqual([]);

    const severeGuessability = corpus.questions.flatMap((question) => {
      const profile = analyzeGuessability(question.options);
      const severity = getGuessabilitySeverity(profile.score);
      return severity === 'high' || severity === 'critical'
        ? [{ id: question.id, severity, issues: profile.issues }]
        : [];
    });
    expect(severeGuessability).toEqual([]);
  });
});
