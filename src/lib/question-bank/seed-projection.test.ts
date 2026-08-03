import { describe, expect, it } from 'vitest';
import type { CuratedQuestion } from './types';
import { projectCuratedQuestionForBulk } from './seed';

describe('projectCuratedQuestionForBulk', () => {
  it('is source-authoritative for public membership, provenance, and nullable fields', () => {
    const question: CuratedQuestion = {
      id: 'bank:usmle-step1:test:v1',
      sourceFile: 'open-content/usmle/step1/questions/test.v1.json',
      rotation: 'usmle-step1',
      moduleNodes: ['usmle/step1'],
      topics: ['test'],
      questionType: 'mechanism',
      difficulty: 'medium',
      stem: 'What happens to PaCO2?',
      options: [
        { label: 'A', text: 'PaCO2 falls', isCorrect: true },
        { label: 'B', text: 'PaCO2 rises', isCorrect: false },
      ],
      context: 'PaCO2 changes with ventilation.',
      publicUsmle: {
        schemaVersion: 1,
        origin: 'authored',
        itemText: { licence: 'CC-BY-4.0', attribution: 'MD3 contributors' },
        evidence: {
          kind: 'passage',
          sourceId: 'source-1',
          passageId: 'passage-1',
          licence: { cls: 'foss', id: 'us-gov' },
        },
      },
    };

    const projected = projectCuratedQuestionForBulk(question);

    expect(projected).toEqual(expect.objectContaining({
      id: question.id,
      sourceFile: question.sourceFile,
      stem: 'What happens to PaCO₂?',
      context: 'PaCO₂ changes with ventilation.',
      moduleNodes: ['usmle/step1'],
      week: null,
      imageUrl: null,
      imageCaption: null,
      citationMetadata: { publicUsmle: question.publicUsmle },
    }));
  });
});
