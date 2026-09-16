import { describe, expect, it } from 'vitest';
import type { CuratedQuestion } from '@/lib/question-bank/types';
import {
  buildPublicUsmleServingDriftReport,
  expectedPublicUsmleStoredQuestion,
  publicUsmleServingDriftFailures,
  publicUsmleServingFingerprint,
  type PublicUsmleStoredQuestion,
} from './public-serving-drift';

function sourceQuestion(id = 'bank:usmle-step1:test:v1'): CuratedQuestion {
  return {
    id,
    sourceFile: `open-content/usmle/step1/questions/test/${id}.json`,
    rotation: 'usmle-step1',
    week: 1,
    moduleNodes: ['usmle/step1', 'usmle/step1/test'],
    topics: ['test topic'],
    questionType: 'mechanism',
    difficulty: 'medium',
    stem: 'Which mechanism best explains this finding?',
    options: [
      { label: 'A', text: 'Correct mechanism', isCorrect: true },
      { label: 'B', text: 'Distractor one', isCorrect: false },
      { label: 'C', text: 'Distractor two', isCorrect: false },
      { label: 'D', text: 'Distractor three', isCorrect: false },
    ],
    context: 'A source-grounded teaching explanation.',
    publicUsmle: {
      schemaVersion: 1,
      origin: 'generated',
      itemText: { licence: 'CC-BY-4.0', attribution: 'MD3 contributors' },
      evidence: {
        kind: 'passage',
        sourceId: 'source-1',
        passageId: 'passage-1',
        licence: { cls: 'foss', id: 'us-gov' },
      },
    },
  };
}

describe('public USMLE serving drift', () => {
  it('accepts an exact source-authoritative database projection', () => {
    const source = sourceQuestion();
    const stored = expectedPublicUsmleStoredQuestion(source);
    const report = buildPublicUsmleServingDriftReport([source], [stored]);

    expect(report).toEqual(expect.objectContaining({
      expectedCount: 1,
      databaseCount: 1,
      matchingCount: 1,
      missingIds: [],
      unexpectedIds: [],
      contentDriftIds: [],
      stateDrift: [],
    }));
    expect(publicUsmleServingDriftFailures(report)).toEqual([]);
  });

  it('detects missing, unexpected, content-drifted, and revoked rows', () => {
    const source = sourceQuestion();
    const drifted = {
      ...expectedPublicUsmleStoredQuestion(source),
      context: 'Stale explanation.',
      excluded: true,
    };
    const unexpected = expectedPublicUsmleStoredQuestion(sourceQuestion('unexpected'));
    const report = buildPublicUsmleServingDriftReport([source], [drifted, unexpected]);

    expect(report.contentDriftIds).toEqual([source.id]);
    expect(report.unexpectedIds).toEqual(['unexpected']);
    expect(report.stateDrift).toEqual([{
      questionId: source.id,
      reasons: ['question is excluded'],
    }]);
    expect(publicUsmleServingDriftFailures(report).join('\n')).toMatch(/differ.*source/i);
    expect(publicUsmleServingDriftFailures(report).join('\n')).toMatch(/outside.*manifest/i);
  });

  it('canonicalizes JSON object keys without hiding array-order drift', () => {
    const stored = expectedPublicUsmleStoredQuestion(sourceQuestion());
    const reordered = {
      ...stored,
      citations: {
        publicUsmle: {
          evidence: (stored.citations as { publicUsmle: { evidence: unknown } }).publicUsmle.evidence,
          itemText: (stored.citations as { publicUsmle: { itemText: unknown } }).publicUsmle.itemText,
          origin: 'generated',
          schemaVersion: 1,
        },
      },
    };
    expect(publicUsmleServingFingerprint(reordered as PublicUsmleStoredQuestion)).toBe(
      publicUsmleServingFingerprint(stored),
    );

    const reversed = { ...stored, options: [...(stored.options as unknown[])].reverse() };
    expect(publicUsmleServingFingerprint(reversed as PublicUsmleStoredQuestion)).not.toBe(
      publicUsmleServingFingerprint(stored),
    );
  });
});
