import { describe, expect, it } from 'vitest';
import type { CuratedQuestion } from '@/lib/question-bank/types';
import {
  computeOpenUsmleRegistrySha256,
  computeOpenUsmleQuoteSetSha256,
  parseOpenUsmleSourceRegistry,
} from './open-source-registry';
import type { PublicUsmleProvenanceV1 } from './public-corpus';
import {
  buildPublicUsmleSourceAudit,
  publicUsmleReleaseGateFailures,
} from './public-corpus-audit';

const authored: PublicUsmleProvenanceV1 = {
  schemaVersion: 1,
  origin: 'authored',
  itemText: { licence: 'CC-BY-4.0', attribution: 'MD3 contributors' },
  evidence: {
    kind: 'passage',
    sourceId: 'open-source',
    passageId: 'stable-passage',
    licence: { cls: 'foss', id: 'cc-by-4.0' },
  },
};

const sourceRegistryFixture = {
  id: 'open-source',
  title: 'Open source fixture',
  publisher: 'Fixture publisher',
  canonicalUrl: 'https://example.test/open-source',
  attribution: 'Open source fixture attribution',
  licence: {
    cls: 'foss' as const,
    id: 'cc-by-4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
  },
  passages: [
    {
      id: 'stable-passage',
      locator: 'Fixture section',
      quote: 'A short openly licensed fixture passage.',
    },
  ],
};

const sourceRegistry = parseOpenUsmleSourceRegistry({
  schemaVersion: 1,
  verifiedAt: '2026-08-01',
  quoteSetSha256: computeOpenUsmleQuoteSetSha256([sourceRegistryFixture]),
  registrySha256: computeOpenUsmleRegistrySha256(
    '2026-08-01',
    [sourceRegistryFixture],
  ),
  sources: [sourceRegistryFixture],
});

function audit(
  questions: CuratedQuestion[],
  excludedQuestionIds: ReadonlySet<string> = new Set(),
  options: {
    membersOnly?: boolean;
    baselineQuestionIds?: ReadonlySet<string> | null;
    mechanicalFlawQuestionIds?: ReadonlySet<string>;
  } = {},
) {
  return buildPublicUsmleSourceAudit(
    questions,
    excludedQuestionIds,
    sourceRegistry,
    options,
  );
}

function question(
  id: string,
  overrides: Partial<CuratedQuestion> = {},
): CuratedQuestion {
  return {
    id,
    rotation: 'usmle-step1',
    moduleNodes: ['usmle/step1'],
    topics: ['cardiovascular'],
    questionType: 'mechanism',
    difficulty: 'medium',
    stem: `SECRET STEM ${id}`,
    options: [
      { label: 'A', text: 'SECRET CORRECT ANSWER', isCorrect: true },
      { label: 'B', text: 'SECRET DISTRACTOR', isCorrect: false },
    ],
    context: 'SECRET TEACHING CONTEXT',
    sourceFile: `open-content/usmle/step1/questions/cardiovascular/${id}.json`,
    publicUsmle: authored,
    ...overrides,
  };
}

function questionWithCorrectLabel(id: string, correctLabel: string): CuratedQuestion {
  return question(id, {
    options: ['A', 'B', 'C', 'D', 'E'].map((label) => ({
      label,
      text: label === correctLabel ? 'SECRET CORRECT ANSWER' : `SECRET DISTRACTOR ${label}`,
      isCorrect: label === correctLabel,
    })),
  });
}

describe('buildPublicUsmleSourceAudit', () => {
  it('projects source rows through the canonical policy and emits no answer-bearing metadata', () => {
    const report = audit([
      question('z-eligible'),
      question('a-missing', {
        publicUsmle: undefined,
        cite: 'SECRET RAW CITATION',
        annotations: { source: 'SECRET RAW ANNOTATION' },
      }),
    ]);

    expect(report.basis).toBe('source-projection');
    expect(report.sourceRegistry).toEqual({
      verifiedAt: '2026-08-01',
      quoteSetSha256: sourceRegistry.quoteSetSha256,
      registrySha256: sourceRegistry.registrySha256,
      sourceCount: 1,
      passageCount: 1,
    });
    expect(report.summary).toEqual(expect.objectContaining({
      sourceQuestionCount: 2,
      auditedQuestionCount: 2,
      eligibleCount: 1,
      blockerCount: 1,
    }));
    expect(report.countsByReason).toEqual({
      'eligible-authored': 1,
      'provenance-missing': 1,
    });
    expect(report.items.map((item) => item.questionId)).toEqual(['a-missing', 'z-eligible']);
    expect(report.items[0]).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'provenance-missing',
      lane: 'metadata',
    }));

    const serialised = JSON.stringify(report);
    for (const secret of [
      'SECRET STEM',
      'SECRET CORRECT ANSWER',
      'SECRET DISTRACTOR',
      'SECRET TEACHING CONTEXT',
      'SECRET RAW CITATION',
      'SECRET RAW ANNOTATION',
    ]) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).not.toContain('isCorrect');
    for (const item of report.items) {
      expect(item).not.toHaveProperty('citations');
      expect(item).not.toHaveProperty('annotations');
      expect(item).not.toHaveProperty('stem');
      expect(item).not.toHaveProperty('options');
      expect(item).not.toHaveProperty('context');
    }
  });

  it('uses disk exclusions and groups every canonical reason into an operator lane', () => {
    const report = audit([
      question('excluded'),
      question('instagram', { cite: 'instagram:@usmle_pearls:abc' }),
      question('media', { imageUrl: '/figures/restricted.png' }),
      question('unlicensed', {
        publicUsmle: {
          ...authored,
          itemText: { licence: 'unknown', attribution: 'Unresolved' },
        },
      }),
      question('generated-no-passage', {
        publicUsmle: {
          ...authored,
          origin: 'generated',
          evidence: {
            kind: 'reference',
            sourceId: 'open-source',
            licence: { cls: 'foss', id: 'cc-by-4.0' },
          },
        },
      }),
    ], new Set(['excluded']));

    expect(report.countsByLane).toEqual({
      availability: 1,
      grounding: 1,
      media: 1,
      'restricted-origin': 1,
      rights: 1,
    });
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ questionId: 'excluded', reason: 'excluded', lane: 'availability' }),
      expect.objectContaining({ questionId: 'instagram', reason: 'known-instagram-source', lane: 'restricted-origin' }),
      expect.objectContaining({ questionId: 'media', reason: 'media-provenance-required', lane: 'media' }),
      expect.objectContaining({ questionId: 'unlicensed', reason: 'item-text-licence-not-public', lane: 'rights' }),
      expect.objectContaining({ questionId: 'generated-no-passage', reason: 'generated-grounding-required', lane: 'grounding' }),
    ]));
  });

  it('treats missing membership as a release-root blocker but suppresses it in private candidate mode', () => {
    const nonMember = question('private-non-member', { moduleNodes: ['cah'] });
    const releaseReport = audit([nonMember]);
    expect(releaseReport.items).toEqual([
      expect.objectContaining({ reason: 'not-step1-member', lane: 'out-of-scope' }),
    ]);
    expect(releaseReport.summary.blockerCount).toBe(1);

    const privateReport = audit([nonMember], new Set(), {
      membersOnly: true,
    });
    expect(privateReport.summary).toEqual(expect.objectContaining({
      sourceQuestionCount: 1,
      auditedQuestionCount: 0,
      skippedNonMemberCount: 1,
      blockerCount: 0,
    }));
    expect(privateReport.items).toEqual([]);
  });

  it('emits baseline counts without exposing baseline IDs or question content', () => {
    const report = audit([
      question('baseline-eligible'),
      question('baseline-blocked', { publicUsmle: undefined }),
      question('not-baseline'),
    ], new Set(), {
      baselineQuestionIds: new Set(['baseline-eligible', 'baseline-blocked']),
    });

    expect(report.baseline).toEqual({
      manifestQuestionCount: 2,
      eligibleQuestionCount: 1,
      blockerCount: 1,
    });
    expect(JSON.stringify(report.baseline)).not.toContain('baseline-eligible');
    expect(JSON.stringify(report.baseline)).not.toContain('baseline-blocked');
  });

  it('blocks deterministic item-writing flaws with a stable content-safe reason', () => {
    const report = audit([
      question('mechanical-flaw'),
      question('mechanically-clean'),
    ], new Set(), {
      mechanicalFlawQuestionIds: new Set(['mechanical-flaw']),
    });

    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        questionId: 'mechanical-flaw',
        eligible: false,
        reason: 'item-mechanical-flaw',
        lane: 'item-quality',
        detail: 'deterministic Step 1 item-writing rubric found a release-blocking flaw',
      }),
      expect.objectContaining({ questionId: 'mechanically-clean', eligible: true }),
    ]));
  });

});

describe('publicUsmleReleaseGateFailures', () => {
  it('fails for blockers and an unmet minimum while normal audit construction remains non-throwing', () => {
    const report = audit([
      question('eligible'),
      question('missing', { publicUsmle: undefined }),
    ]);

    expect(publicUsmleReleaseGateFailures(report, 3)).toEqual([
      'eligible corpus has 1 item(s); release requires at least 3',
      '1 audited item(s) fail public eligibility',
    ]);
    expect(publicUsmleReleaseGateFailures(
      audit([question('eligible')]),
      1,
    )).toEqual([]);

    const undersizedBaseline = audit([
      question('baseline-a'),
      question('corpus-b'),
      question('corpus-c'),
    ], new Set(), { baselineQuestionIds: new Set(['baseline-a']) });
    expect(publicUsmleReleaseGateFailures(undersizedBaseline, 3)).toEqual([
      'eligible baseline has 1 item(s); release requires at least 3',
    ]);

    const blockedBaseline = audit([
      question('baseline-eligible'),
      question('baseline-blocked', { publicUsmle: undefined }),
    ], new Set(), {
      baselineQuestionIds: new Set(['baseline-eligible', 'baseline-blocked']),
    });
    expect(publicUsmleReleaseGateFailures(blockedBaseline, 1)).toEqual([
      '1 audited item(s) fail public eligibility',
      '1 baseline item(s) fail public eligibility',
    ]);
  });

  it('fails closed with stable reasons when evidence is absent from the source registry', () => {
    const report = audit([
      question('unknown-source', {
        publicUsmle: {
          ...authored,
          evidence: {
            kind: 'passage',
            sourceId: 'not-registered',
            passageId: 'stable-passage',
            licence: { cls: 'foss', id: 'cc-by-4.0' },
          },
        },
      }),
      question('unknown-passage', {
        publicUsmle: {
          ...authored,
          origin: 'generated',
          evidence: {
            kind: 'passage',
            sourceId: 'open-source',
            passageId: 'not-registered',
            licence: { cls: 'foss', id: 'cc-by-4.0' },
          },
        },
      }),
      question('licence-mismatch', {
        publicUsmle: {
          ...authored,
          evidence: {
            kind: 'passage',
            sourceId: 'open-source',
            passageId: 'stable-passage',
            licence: { cls: 'foss', id: 'cc-by-sa-4.0' },
          },
        },
      }),
      question('registered-passage', {
        publicUsmle: {
          ...authored,
          origin: 'generated',
          evidence: {
            kind: 'passage',
            sourceId: 'open-source',
            passageId: 'stable-passage',
            licence: { cls: 'foss', id: 'cc-by-4.0' },
          },
        },
      }),
    ]);

    expect(report.countsByReason).toEqual({
      'eligible-generated': 1,
      'evidence-licence-mismatch': 1,
      'evidence-passage-not-registered': 1,
      'evidence-source-not-registered': 1,
    });
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        questionId: 'unknown-source',
        reason: 'evidence-source-not-registered',
        lane: 'grounding',
      }),
      expect.objectContaining({
        questionId: 'unknown-passage',
        reason: 'evidence-passage-not-registered',
        lane: 'grounding',
      }),
      expect.objectContaining({
        questionId: 'licence-mismatch',
        reason: 'evidence-licence-mismatch',
        lane: 'rights',
      }),
    ]));
  });

  it('adds aggregate answer-key failures without marking an individual item', () => {
    const labels = [
      ...Array(10).fill('A'),
      'C', 'B', 'D', 'C', 'B', 'C', 'B', 'A', 'D', 'D', 'B', 'A', 'C', 'A', 'A',
    ];
    const report = audit(labels.map((label, index) => (
      questionWithCorrectLabel(`biased-${index}`, label)
    )));

    expect(report.summary).toEqual(expect.objectContaining({
      eligibleCount: 25,
      blockerCount: 0,
    }));
    expect(report.items.every((item) => item.eligible)).toBe(true);
    expect(publicUsmleReleaseGateFailures(report, 25)).toEqual([
      'raw answer key represents 4/5 labels; 5 are required at this corpus size',
      'raw answer key puts 14/25 answers on one label; maximum share is 40%',
      'raw answer key has a 10-item same-label streak; maximum is 5',
    ]);
  });

  it('audits answer streaks in baseline-manifest order rather than disk order', () => {
    const labels = ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'A'];
    const questions = labels.map((label, index) => (
      questionWithCorrectLabel(`ordered-${index}`, label)
    ));
    const baselineOrder = [0, 2, 4, 6, 8, 9, 1, 3, 5, 7]
      .map((index) => questions[index].id);

    const report = audit(questions, new Set(), {
      baselineQuestionIds: new Set(baselineOrder),
    });

    expect(report.rawAnswerKey.longestSameLabelStreak).toBe(6);
    expect(publicUsmleReleaseGateFailures(report, 10)).toContain(
      'raw answer key has a 6-item same-label streak; maximum is 5',
    );
  });
});
