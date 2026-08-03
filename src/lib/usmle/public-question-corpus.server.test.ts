import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: { question: { findMany: vi.fn() } },
}));

import { loadPublicUsmleQuestionCorpus } from './public-question-corpus.server';
import type { OpenUsmleReleaseManifest } from './public-release';
import { publicUsmleServingFingerprint } from './public-serving-fingerprint';

const authoredProvenance = {
  schemaVersion: 1,
  origin: 'authored',
  itemText: { licence: 'CC-BY-4.0', attribution: 'Ian Todd / md3' },
  evidence: {
    kind: 'passage',
    sourceId: 'cdc-pink-book-vaccine-principles',
    passageId: 'passive-immunity',
    licence: { cls: 'foss', id: 'us-gov' },
  },
} as const;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bank:usmle-step1:passive-immunity-time-course:v1',
    stem: 'A clinical vignette asks which mechanism is most likely?',
    options: [
      { label: 'A', text: 'The correct mechanism', isCorrect: true },
      { label: 'B', text: 'A distractor', isCorrect: false },
    ],
    context: 'A teaching explanation.',
    rotation: 'cah',
    week: null,
    topics: ['cah', 'usmle-step1'],
    moduleNodes: ['cah', 'usmle/step1'],
    source: 'bank',
    sourceFile: 'question-bank/cah/step1-public.v1.json',
    questionType: 'mechanism',
    difficulty: 'medium',
    format: 'single-best-answer',
    imageUrl: null,
    imageCaption: null,
    crosslinks: null,
    abbreviations: null,
    combinations: null,
    correctVariants: null,
    variantGroupId: 'family:step1-public',
    variantType: 'near-duplicate',
    contentState: 'enhanced',
    excluded: false,
    citations: { publicUsmle: authoredProvenance },
    annotations: { source: 'md3 original' },
    ...overrides,
  };
}

function releaseForRows(
  ...rows: ReturnType<typeof row>[]
): OpenUsmleReleaseManifest {
  return {
    schemaVersion: 2,
    questionIds: rows.map((candidate) => candidate.id),
    questionFingerprints: Object.fromEntries(
      rows.map((candidate) => [
        candidate.id,
        publicUsmleServingFingerprint(candidate as never),
      ]),
    ),
  };
}

describe('loadPublicUsmleQuestionCorpus', () => {
  it('queries by moduleNodes membership and filters candidates through the contract', async () => {
    const eligibleRow = row();
    const findMany = vi.fn().mockResolvedValue([
      eligibleRow,
      row({
        id: 'bank:usmle-step1:instagram:v1',
        rotation: 'usmle-step1',
        citations: {
          cite: 'instagram:@usmle_pearls:abc',
          publicUsmle: authoredProvenance,
        },
      }),
    ]);

    const result = await loadPublicUsmleQuestionCorpus({
      question: { findMany },
    } as never, undefined, releaseForRows(eligibleRow));

    expect(findMany).toHaveBeenCalledTimes(1);
    const query = findMany.mock.calls[0][0];
    expect(JSON.stringify(query.where)).toContain('"moduleNodes":{"has":"usmle/step1"}');
    expect(JSON.stringify(query.where)).toContain('"id":{"in":[');
    expect(JSON.stringify(query.where)).not.toContain('"rotation":"usmle-step1"');

    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toEqual(expect.objectContaining({
      id: 'bank:usmle-step1:passive-immunity-time-course:v1',
      rotation: 'cah',
      renderEvidenceQuote: true,
      publicProvenance: authoredProvenance,
      resolvedCitation: expect.objectContaining({
        canonicalUrl: expect.stringContaining('cdc.gov'),
      }),
      variantGroupId: 'family:step1-public',
      variantType: 'near-duplicate',
    }));
    expect(result.questions[0]).not.toHaveProperty('citations');
    expect(result.questions[0]).not.toHaveProperty('annotations');
    expect(result.questions[0]).not.toHaveProperty('sourceFile');

    expect(result.decisions).toEqual([
      expect.objectContaining({
        questionId: 'bank:usmle-step1:passive-immunity-time-course:v1',
        decision: expect.objectContaining({ eligible: true }),
      }),
      expect.objectContaining({
        questionId: 'bank:usmle-step1:instagram:v1',
        decision: expect.objectContaining({
          eligible: false,
          reason: 'not-release-manifest-member',
        }),
      }),
    ]);
  });

  it('returns no question when a cross-listed row lacks durable provenance', async () => {
    const currentRow = row({
      citations: null,
      annotations: {
        source: 'foss-grounded-vignette',
        groundedOn: 'legacy passage marker',
      },
    });
    const findMany = vi.fn().mockResolvedValue([currentRow]);

    const result = await loadPublicUsmleQuestionCorpus({
      question: { findMany },
    } as never, undefined, releaseForRows(currentRow));

    expect(result.questions).toEqual([]);
    expect(result.decisions[0].decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'provenance-missing',
    }));
  });

  it('rejects an otherwise eligible row whose evidence source is not registered', async () => {
    const currentRow = row({
      citations: {
        publicUsmle: {
          ...authoredProvenance,
          evidence: {
            kind: 'passage',
            sourceId: 'forged-source',
            passageId: 'forged-passage',
            licence: { cls: 'foss', id: 'us-gov' },
          },
        },
      },
    });
    const findMany = vi.fn().mockResolvedValue([currentRow]);

    const result = await loadPublicUsmleQuestionCorpus({
      question: { findMany },
    } as never, undefined, releaseForRows(currentRow));

    expect(result.questions).toEqual([]);
    expect(result.decisions[0].decision).toEqual({
      eligible: false,
      reason: 'evidence-source-not-registered',
      detail: 'evidence source is absent from the checked-in source registry',
    });
  });

  it('rejects a DB evidence licence that disagrees with the checked-in source', async () => {
    const currentRow = row({
      citations: {
        publicUsmle: {
          ...authoredProvenance,
          evidence: {
            kind: 'passage',
            sourceId: 'cdc-pink-book-vaccine-principles',
            passageId: 'passive-immunity',
            licence: { cls: 'foss', id: 'cc-by-4.0' },
          },
        },
      },
    });
    const findMany = vi.fn().mockResolvedValue([currentRow]);

    const result = await loadPublicUsmleQuestionCorpus({
      question: { findMany },
    } as never, undefined, releaseForRows(currentRow));

    expect(result.questions).toEqual([]);
    expect(result.decisions[0].decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'evidence-licence-mismatch',
    }));
  });

  it('rejects an unknown passage even when its source and licence are registered', async () => {
    const currentRow = row({
      citations: {
        publicUsmle: {
          ...authoredProvenance,
          evidence: {
            kind: 'passage',
            sourceId: 'cdc-pink-book-vaccine-principles',
            passageId: 'not-in-the-registry',
            licence: { cls: 'foss', id: 'us-gov' },
          },
        },
      },
    });
    const findMany = vi.fn().mockResolvedValue([currentRow]);

    const result = await loadPublicUsmleQuestionCorpus({
      question: { findMany },
    } as never, undefined, releaseForRows(currentRow));

    expect(result.questions).toEqual([]);
    expect(result.decisions[0].decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'evidence-passage-not-registered',
    }));
  });

  it('attaches only a sanitized citation resolved from the checked-in registry', async () => {
    const publicUsmle = {
      ...authoredProvenance,
      evidence: {
        kind: 'passage',
        sourceId: 'cdc-pink-book-vaccine-principles',
        passageId: 'passive-immunity',
        licence: { cls: 'foss', id: 'us-gov' },
      },
    } as const;
    const currentRow = row({ citations: { publicUsmle } });
    const findMany = vi.fn().mockResolvedValue([currentRow]);

    const result = await loadPublicUsmleQuestionCorpus({
      question: { findMany },
    } as never, undefined, releaseForRows(currentRow));

    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].resolvedCitation).toEqual({
      kind: 'passage',
      title: 'Pink Book, Chapter 1: Principles of Vaccination',
      publisher: 'Centers for Disease Control and Prevention',
      canonicalUrl: 'https://www.cdc.gov/pinkbook/hcp/table-of-contents/chapter-1-principles-of-vaccination.html',
      attribution: 'Source: Centers for Disease Control and Prevention (CDC). This material is also available from CDC at no charge. No CDC or U.S. Government endorsement is implied.',
      licence: {
        id: 'us-gov',
        url: 'https://www.cdc.gov/other/agencymaterials.html',
      },
      passageLocator: 'Types of Immunity > Passive Immunity',
      quote: 'Passive immunity provides immediate protection against infection, but that protection is temporary.',
    });
    expect(result.questions[0].resolvedCitation).not.toHaveProperty('sourceId');
    expect(result.questions[0].resolvedCitation).not.toHaveProperty('passageId');
    expect(result.questions[0].resolvedCitation).not.toHaveProperty('cls');
  });

  it('rejects a serving row that drifted after the release fingerprint was built', async () => {
    const releasedRow = row();
    const driftedRow = row({ context: 'A mutated explanation.' });
    const findMany = vi.fn().mockResolvedValue([driftedRow]);

    const result = await loadPublicUsmleQuestionCorpus({
      question: { findMany },
    } as never, undefined, releaseForRows(releasedRow));

    expect(result.questions).toEqual([]);
    expect(result.decisions[0].decision).toEqual({
      eligible: false,
      reason: 'release-content-drift',
      detail: 'serving row differs from the checked-in release source',
    });
  });
});
