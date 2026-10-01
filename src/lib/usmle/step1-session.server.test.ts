import { describe, expect, it, vi } from 'vitest';
import {
  USMLE_STEP1_BASELINE_MODULE,
  answerStep1Delivery,
  computeStep1QuestionContentHash,
  createStep1Session,
  replayStep1Session,
  getStep1Progress,
  type Step1DeliveryRow,
  type Step1StoredDelivery,
} from './step1-session.server';
import { PUBLIC_USMLE_DELIVERY_WRITE_CAPABILITY } from '@/lib/review/record-question-attempt';
import { step1MediaSourcePresentation } from './step1-media-source.server';
import publicVisualAssetManifest from '../../../open-content/usmle/step1/visual-assets-v1.json';

import type { PublicUsmleQuestion } from './public-question-corpus.server';

const NOW = new Date('2026-08-01T08:00:00.000Z');
const RELEASE_FINGERPRINT = 'a'.repeat(64);

const provenance = {
  schemaVersion: 1,
  origin: 'authored',
  itemText: {
    licence: 'CC-BY-4.0',
    attribution: 'md3 contributors',
  },
  evidence: { kind: 'none' },
} as const;

function question(
  id: string,
  domain: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    stem: `Clinical stem for ${id}`,
    options: [
      { label: 'A', text: 'Correct option', isCorrect: true, explanation: 'Why A wins.' },
      { label: 'B', text: 'Distractor B', isCorrect: false, explanation: 'Why B loses.' },
      { label: 'C', text: 'Distractor C', isCorrect: false },
      { label: 'D', text: 'Distractor D', isCorrect: false },
    ],
    context: `Teaching explanation for ${id}`,
    rotation: domain,
    week: null,
    topics: [domain, 'usmle-step1'],
    moduleNodes: ['usmle/step1', USMLE_STEP1_BASELINE_MODULE],
    questionType: 'mechanism',
    difficulty: 'medium',
    imageUrl: null,
    imageCaption: null,
    crosslinks: null,
    abbreviations: null,
    combinations: null,
    correctVariants: null,
    variantGroupId: null,
    variantType: null,
    publicProvenance: provenance,
    renderEvidenceQuote: false,
    resolvedCitation: null,
    releaseFingerprint: RELEASE_FINGERPRINT,
    ...overrides,
  } as never;
}

function corpus(questions: PublicUsmleQuestion[]) {
  return { questions, decisions: [] };
}

function currentQrsVisualQuestion(
  id = 'q-answer',
  assetId = 'ecg-case-2w7m4q',
) {
  const asset = publicVisualAssetManifest.assets.find(
    (candidate) => candidate.assetId === assetId,
  );
  if (!asset) throw new Error(`Expected released visual asset ${assetId}`);
  return {
    asset,
    question: question(id, 'usmle-cardio', {
      imageUrl: `/figures/usmle/step1/${asset.relativePath.slice('media/'.length)}`,
      imageCaption: asset.accessibility.preAnswerAlt,
      publicProvenance: {
        ...provenance,
        media: {
          kind: 'asset',
          assetId: asset.assetId,
          job: 'trace',
          showWhen: 'always',
          licence: { cls: 'foss', id: asset.rights.licenceId.toLowerCase() },
          attribution: asset.rights.attribution,
          contentHash: asset.sha256,
          clinicalConditionIds: asset.clinical.conditionIds,
          clinicalKeyFindings: asset.clinical.keyFindings,
        },
      },
    }),
  };
}

function idFactory(...ids: string[]) {
  let index = 0;
  return () => ids[index++] ?? `opaque-${index}`;
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe('figure-bearing question deliverability', () => {
  // 345 of the 556 released questions carry an imageUrl. Excluding every one of
  // them left the public corpus at 72 deliverable items and made all 25 pinned
  // baseline questions unreachable, so a first-run visitor got an empty session.
  // Paired with a plain deliverable question so these assert FILTERING rather
  // than the empty-corpus error a single excluded question would raise.
  async function deliveredIds(imageUrl: string | null) {
    const rows: Step1DeliveryRow[] = [];
    await createStep1Session(
      { userId: 'guest-1', mode: 'daily', size: 5, now: NOW },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('q-plain', 'usmle-cardio'),
          question('q-figure', 'usmle-renal', { imageUrl }),
        ])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn(async (input: Step1DeliveryRow[]) => {
          rows.push(...input);
          return input.length;
        }),
        createId: idFactory('session-figure', 'delivery-a', 'delivery-b'),
        random: () => 0,
      },
    );
    return rows.map((row) => row.itemId);
  }

  it('delivers a question illustrated by the open CC BY Step 1 corpus', async () => {
    expect(await deliveredIds('/figures/usmle/step1/adrenal-zones-v1.svg'))
      .toEqual(expect.arrayContaining(['q-plain', 'q-figure']));
  });

  it('still withholds a question illustrated by rights-managed media', async () => {
    const ids = await deliveredIds('/figures/anking/textbook-scan.jpg');
    expect(ids).toContain('q-plain');
    expect(ids).not.toContain('q-figure');
  });

  it('withholds a question whose figure escapes the open namespace', async () => {
    const ids = await deliveredIds('/figures/usmle/step1/../anking/scan.svg');
    expect(ids).toContain('q-plain');
    expect(ids).not.toContain('q-figure');
  });

  it('projects only explicitly prompt-safe open trace media into the session item', async () => {
    const { asset, question: visualQuestion } = currentQrsVisualQuestion('q-ecg');
    const sourcePresentation = step1MediaSourcePresentation(asset.rights.sourcePageUrl);
    if (!sourcePresentation) throw new Error('Expected reviewed QRS source presentation');
    const result = await createStep1Session(
      {
        userId: 'guest-1',
        mode: 'daily',
        size: 1,
        now: new Date('2026-08-14T08:00:00.000Z'),
        surface: 'cohort',
      },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([visualQuestion])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn(async (input: Step1DeliveryRow[]) => input.length),
        createId: idFactory('session-ecg', 'delivery-ecg'),
        random: () => 0,
      },
    );

    expect(result.items[0].media).toEqual({
      imageUrl: '/figures/usmle/step1/ecg-case-2w7m4q.svg',
      preAnswerAlt: asset.accessibility.preAnswerAlt,
      class: 'diagnostic',
      showWhen: 'always',
      modality: 'ecg',
      attributionText: sourcePresentation.attributionText,
      licenseUrl: asset.rights.licenceUrl,
      sourcePageUrl: asset.rights.sourcePageUrl,
    });
  });

  it('keeps an answer-bearing VTaC source URI out of the prompt transport', async () => {
    const { question: visualQuestion } = currentQrsVisualQuestion(
      'q-vt',
      'ecg-case-8v5c2h',
    );
    const result = await createStep1Session(
      {
        userId: 'guest-1',
        mode: 'daily',
        size: 1,
        now: new Date('2026-08-14T08:00:00.000Z'),
        surface: 'cohort',
      },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([visualQuestion])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn(async (input: Step1DeliveryRow[]) => input.length),
        createId: idFactory('session-vt', 'delivery-vt'),
        random: () => 0,
      },
    );

    expect(result.items[0].media).toMatchObject({
      attributionText: expect.stringContaining('Lehman et al. via PhysioNet'),
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    });
    expect(result.items[0].media).not.toHaveProperty('sourcePageUrl');
    expect(JSON.stringify(result.items[0])).not.toMatch(/vtac|ventricular.tachycardia/i);
  });

  it('withholds prompt media whose question receipt names different clinical findings', async () => {
    await expect(createStep1Session(
      {
        userId: 'guest-1',
        mode: 'daily',
        size: 1,
        now: new Date('2026-08-14T08:00:00.000Z'),
        surface: 'cohort',
      },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('q-miswired-ecg', 'usmle-cardio', {
            imageUrl: '/figures/usmle/step1/ecg-case-2w7m4q.svg',
            imageCaption: 'A diagnosis-neutral teaching strip.',
            publicProvenance: {
              ...provenance,
              media: {
                kind: 'asset',
                assetId: 'ecg-case-2w7m4q',
                job: 'trace',
                showWhen: 'always',
                licence: { cls: 'foss', id: 'cc-by-4.0' },
                attribution: 'MD3 contributors',
                contentHash: 'sha256:5e3847025a13219b16ba026b707c766a3364cb74472279fceb9968035673c3b6',
                clinicalConditionIds: ['atrial-fibrillation'],
                clinicalKeyFindings: ['Irregularly irregular rhythm'],
              },
            },
          }),
        ])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn(),
        createId: idFactory('session-miswired'),
        random: () => 0,
      },
    )).rejects.toMatchObject({
      status: 409,
      code: 'corpus_not_ready',
    });
  });

  it('does not send after-reveal media or captions before the answer', async () => {
    const result = await createStep1Session(
      { userId: 'guest-1', mode: 'daily', size: 1, now: NOW, surface: 'cohort' },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('q-hidden-figure', 'usmle-cardio', {
            imageUrl: '/figures/usmle/step1/answer-revealing-v1.svg',
            imageCaption: 'This caption names the answer.',
            publicProvenance: {
              ...provenance,
              media: {
                kind: 'asset',
                assetId: 'answer-revealing-v1',
                job: 'finding-exemplar',
                showWhen: 'after-reveal',
                licence: { cls: 'foss', id: 'cc-by-4.0' },
                attribution: 'MD3 contributors',
              },
            },
          }),
        ])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn(async (input: Step1DeliveryRow[]) => input.length),
        createId: idFactory('session-hidden', 'delivery-hidden'),
        random: () => 0,
      },
    );

    expect(result.items[0]).not.toHaveProperty('media');
    expect(JSON.stringify(result.items[0])).not.toContain('names the answer');
  });
});

describe('createStep1Session', () => {
  it('binds the resolved public citation into the delivery content hash', () => {
    const withoutCitation = question('q-hash', 'usmle-cardio');
    const withCitation = question('q-hash', 'usmle-cardio', {
      resolvedCitation: {
        kind: 'reference',
        title: 'Open source',
        publisher: 'Public publisher',
        canonicalUrl: 'https://example.org/source',
        attribution: 'Public publisher',
        licence: { id: 'cc-by-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
        passageLocator: null,
      },
    });

    expect(computeStep1QuestionContentHash(withCitation))
      .not.toBe(computeStep1QuestionContentHash(withoutCitation));
  });

  it('persists an opaque server shuffle before returning an answer-safe payload', async () => {
    const rows: Step1DeliveryRow[] = [];
    const loadHistory = vi.fn().mockResolvedValue([]);
    const persistDeliveries = vi.fn(async (input: Step1DeliveryRow[]) => {
      rows.push(...input);
      return input.length;
    });

    const result = await createStep1Session(
      { userId: 'admin-1', mode: 'baseline', size: 2, now: NOW },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('q-cardio-1', 'usmle-cardio'),
          question('q-renal-1', 'usmle-renal'),
        ])),
        loadHistory,
        persistDeliveries,
        createId: idFactory('session-opaque', 'delivery-one', 'delivery-two'),
        random: () => 0,
      },
    );

    expect(persistDeliveries).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'delivery-one',
      userId: 'admin-1',
      sessionId: 'session-opaque',
      itemType: 'question',
      itemId: 'q-cardio-1',
      deliveryPath: 'live',
      decisionPath: 'usmle-step1-baseline-v1',
    });
    expect(rows[0].payload).toMatchObject({
      contract: 'usmle-step1-delivery-v3',
      mode: 'baseline',
      surface: 'usmle-step1',
      displayToOriginal: expect.any(Object),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      servingFingerprint: RELEASE_FINGERPRINT,
    });

    expect(result).toMatchObject({
      sessionId: 'session-opaque',
      mode: 'baseline',
      requestedSize: 2,
      deliveredSize: 2,
    });
    expect(result.items[0]).toEqual({
      deliveryId: 'delivery-one',
      stem: 'Clinical stem for q-cardio-1',
      options: expect.arrayContaining([
        expect.objectContaining({ label: 'A', text: expect.any(String) }),
      ]),
      domain: 'usmle-cardio',
      difficulty: 'medium',
      questionType: 'mechanism',
      attribution: {
        text: 'md3 contributors',
        licence: 'CC-BY-4.0',
      },
    });

    const forbidden = new Set([
      'id',
      'isCorrect',
      'context',
      'explanation',
      'originalIndex',
      'originalLabel',
      'provenance',
      'publicProvenance',
      'citations',
      'source',
      'sourceFile',
      'topics',
      'combinations',
      'correctVariants',
    ]);
    const leaked = [...collectKeys(result)].filter((key) => forbidden.has(key));
    expect(leaked).toEqual([]);
  });

  it('fails closed and returns no prompt when ServeDecision persistence fails', async () => {
    const loadCorpus = vi.fn().mockResolvedValue(corpus([
      question('q-cardio-1', 'usmle-cardio'),
    ]));

    await expect(createStep1Session(
      { userId: 'admin-1', mode: 'daily', size: 1, now: NOW },
      {
        loadCorpus,
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn().mockRejectedValue(new Error('database unavailable')),
        createId: idFactory('session-opaque', 'delivery-one'),
        random: () => 0.5,
      },
    )).rejects.toMatchObject({ status: 503, code: 'delivery_persistence_failed' });
  });

  it('also fails closed when the strict writer reports a partial batch', async () => {
    await expect(createStep1Session(
      { userId: 'admin-1', mode: 'daily', size: 2, now: NOW },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('q-cardio-1', 'usmle-cardio'),
          question('q-renal-1', 'usmle-renal'),
        ])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn().mockResolvedValue(1),
        createId: idFactory('session-opaque', 'delivery-one', 'delivery-two'),
        random: () => 0.5,
      },
    )).rejects.toMatchObject({ status: 503, code: 'delivery_persistence_failed' });
  });

  it('spans baseline domains and excludes every previously answered baseline item', async () => {
    const result = await createStep1Session(
      { userId: 'admin-1', mode: 'baseline', size: 3, now: NOW },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('cardio-a', 'usmle-cardio'),
          question('cardio-b', 'usmle-cardio'),
          question('renal-a', 'usmle-renal'),
          question('renal-b', 'usmle-renal'),
        ])),
        loadHistory: vi.fn().mockResolvedValue([
          { questionId: 'cardio-a', isCorrect: false, createdAt: new Date('2026-07-01T00:00:00Z'), sessionType: 'usmle-baseline-v1' },
        ]),
        persistDeliveries: vi.fn(async (rows: Step1DeliveryRow[]) => rows.length),
        createId: idFactory('session-opaque', 'd1', 'd2', 'd3'),
        random: () => 0.5,
      },
    );

    expect(result.items.map((item) => item.stem)).not.toContain('Clinical stem for cardio-a');
    expect(result.items.slice(0, 2).map((item) => item.domain).sort()).toEqual([
      'usmle-cardio',
      'usmle-renal',
    ]);
  });

  it('mixes missed/stale and unseen daily work while suppressing semantic siblings', async () => {
    const result = await createStep1Session(
      { userId: 'admin-1', mode: 'daily', size: 4, now: NOW },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('missed-a', 'usmle-cardio', {
            variantGroupId: 'near-family',
            variantType: 'near-duplicate',
          }),
          question('unseen-sibling', 'usmle-cardio', {
            variantGroupId: 'near-family',
            variantType: 'near-duplicate',
          }),
          question('stale-a', 'usmle-renal'),
          question('unseen-a', 'usmle-immunology'),
          question('unseen-b', 'usmle-biochem'),
          question('invalid-answer', 'usmle-pathology', {
            options: [
              { label: 'A', text: 'A', isCorrect: true },
              { label: 'B', text: 'B', isCorrect: true },
              { label: 'C', text: 'C', isCorrect: false },
              { label: 'D', text: 'D', isCorrect: false },
            ],
          }),
        ])),
        loadHistory: vi.fn().mockResolvedValue([
          { questionId: 'missed-a', isCorrect: false, createdAt: new Date('2026-07-31T00:00:00Z'), sessionType: 'usmle-daily-v1' },
          { questionId: 'stale-a', isCorrect: true, createdAt: new Date('2026-01-01T00:00:00Z'), sessionType: 'usmle-daily-v1' },
        ]),
        persistDeliveries: vi.fn(async (rows: Step1DeliveryRow[]) => rows.length),
        createId: idFactory('session-opaque', 'd1', 'd2', 'd3', 'd4'),
        random: () => 0.5,
      },
    );

    const stems = result.items.map((item) => item.stem);
    expect(stems).toEqual(expect.arrayContaining([
      'Clinical stem for missed-a',
      'Clinical stem for stale-a',
      'Clinical stem for unseen-a',
    ]));
    expect(stems.filter((stem) => stem.includes('missed-a') || stem.includes('unseen-sibling')))
      .toHaveLength(1);
    expect(stems).not.toContain('Clinical stem for invalid-answer');
  });

  it('uses answered question tiers when adapting the next unseen daily item', async () => {
    const result = await createStep1Session(
      { userId: 'guest-1', mode: 'daily', size: 1, now: NOW },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('answered-easy-a', 'usmle-cardio', { difficulty: 'easy' }),
          question('answered-easy-b', 'usmle-cardio', { difficulty: 'easy' }),
          question('next-medium', 'usmle-cardio', { difficulty: 'medium' }),
          question('next-hard', 'usmle-cardio', { difficulty: 'hard' }),
        ])),
        loadHistory: vi.fn().mockResolvedValue([
          {
            questionId: 'answered-easy-a',
            isCorrect: true,
            createdAt: new Date('2026-08-01T07:00:00Z'),
            sessionType: 'usmle-daily-v1',
          },
          {
            questionId: 'answered-easy-b',
            isCorrect: true,
            createdAt: new Date('2026-08-01T07:30:00Z'),
            sessionType: 'usmle-daily-v1',
          },
        ]),
        persistDeliveries: vi.fn(async (rows: Step1DeliveryRow[]) => rows.length),
        createId: idFactory('session-tier', 'delivery-tier'),
        random: () => 0.5,
      },
    );

    // Two consecutive easy successes promote to medium. If session integration
    // loses the answered questions' metadata, both unknown tiers normalize to
    // medium and the ranker incorrectly promotes this learner to hard.
    expect(result.items[0]).toMatchObject({
      stem: 'Clinical stem for next-medium',
      difficulty: 'medium',
    });
  });

  it('uses the missed question ladder when ordering the next unseen daily item', async () => {
    const result = await createStep1Session(
      { userId: 'guest-1', mode: 'daily', size: 2, now: NOW },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('missed-hard', 'usmle-renal', {
            difficulty: 'hard',
            topics: ['usmle-renal', 'usmle-step1', 'ladder:pct-reabsorption'],
          }),
          question('a-unrelated-medium', 'usmle-renal', {
            difficulty: 'medium',
            topics: ['usmle-renal', 'usmle-step1', 'ladder:acid-base'],
          }),
          question('z-same-ladder-medium', 'usmle-renal', {
            difficulty: 'medium',
            topics: ['usmle-renal', 'usmle-step1', 'ladder:pct-reabsorption'],
          }),
        ])),
        loadHistory: vi.fn().mockResolvedValue([
          {
            questionId: 'missed-hard',
            isCorrect: false,
            createdAt: new Date('2026-08-01T07:30:00Z'),
            sessionType: 'usmle-daily-v1',
          },
        ]),
        persistDeliveries: vi.fn(async (rows: Step1DeliveryRow[]) => rows.length),
        createId: idFactory('session-ladder', 'delivery-review', 'delivery-scaffold'),
        random: () => 0.5,
      },
    );

    // Daily review retains the missed item first. The next unseen item should
    // then be the easier rung from that exact ladder, even though its id sorts
    // after an unrelated question at the same tier and in the same domain.
    expect(result.items.map((item) => item.stem)).toEqual([
      'Clinical stem for missed-hard',
      'Clinical stem for z-same-ladder-medium',
    ]);
  });

  it('can put an adaptive unseen scaffold ahead of replay for a one-card public turn', async () => {
    const rows: Step1DeliveryRow[] = [];
    const result = await createStep1Session(
      {
        userId: 'guest-1',
        mode: 'daily',
        size: 1,
        now: NOW,
        preferAdaptiveUnseen: true,
        adaptiveCandidatePreference: { topicTags: ['blood pressure'] },
      },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('missed-hard', 'usmle-renal', {
            difficulty: 'hard',
            topics: ['usmle-renal', 'usmle-step1', 'ladder:pct-reabsorption'],
          }),
          question('a-unrelated-medium', 'usmle-renal', {
            difficulty: 'medium',
            topics: ['usmle-renal', 'usmle-step1', 'ladder:acid-base'],
          }),
          question('z-same-ladder-medium', 'usmle-renal', {
            difficulty: 'medium',
            topics: ['usmle-renal', 'usmle-step1', 'ladder:pct-reabsorption'],
          }),
          question('lay-purchase-medium', 'usmle-cardio', {
            difficulty: 'medium',
            topics: ['blood pressure'],
          }),
        ])),
        loadHistory: vi.fn().mockResolvedValue([
          {
            questionId: 'missed-hard',
            isCorrect: false,
            createdAt: new Date('2026-08-01T07:30:00Z'),
            sessionType: 'usmle-daily-v1',
          },
        ]),
        persistDeliveries: vi.fn(async (input: Step1DeliveryRow[]) => {
          rows.push(...input);
          return input.length;
        }),
        createId: idFactory('session-public-turn', 'delivery-scaffold'),
        random: () => 0.5,
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId: 'z-same-ladder-medium',
      queueReason: 'daily-unseen',
    });
    expect(result.items[0]).toMatchObject({
      stem: 'Clinical stem for z-same-ladder-medium',
      difficulty: 'medium',
    });
  });

  it('returns to review after the immediate public scaffold instead of starving misses', async () => {
    const result = await createStep1Session(
      {
        userId: 'guest-1',
        mode: 'daily',
        size: 1,
        now: NOW,
        preferAdaptiveUnseen: true,
      },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('missed-hard', 'usmle-renal', {
            difficulty: 'hard',
            topics: ['ladder:pct-reabsorption'],
          }),
          question('answered-scaffold', 'usmle-renal', {
            difficulty: 'medium',
            topics: ['ladder:pct-reabsorption'],
          }),
          question('another-unseen', 'usmle-cardio', { difficulty: 'medium' }),
        ])),
        loadHistory: vi.fn().mockResolvedValue([
          {
            questionId: 'missed-hard',
            isCorrect: false,
            createdAt: new Date('2026-08-01T07:30:00Z'),
            sessionType: 'cohort-daily-v1',
          },
          {
            questionId: 'answered-scaffold',
            isCorrect: true,
            createdAt: new Date('2026-08-01T07:31:00Z'),
            sessionType: 'cohort-daily-v1',
          },
        ]),
        persistDeliveries: vi.fn(async (rows: Step1DeliveryRow[]) => rows.length),
        createId: idFactory('session-recovery', 'delivery-replay'),
        random: () => 0.5,
      },
    );

    expect(result.items[0]).toMatchObject({
      stem: 'Clinical stem for missed-hard',
    });
  });

  it('prefers recognizable structured topics for a tied one-card Cohort turn', async () => {
    const rows: Step1DeliveryRow[] = [];
    const result = await createStep1Session(
      {
        userId: 'guest-1',
        mode: 'daily',
        size: 1,
        now: NOW,
        allowedDifficulties: ['easy'],
        preferAdaptiveUnseen: true,
        adaptiveCandidatePreference: { topicTags: ['blood pressure'] },
      },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('a-obscure', 'usmle-biochem', {
            difficulty: 'easy',
            topics: ['porphyrin synthesis'],
          }),
          question('z-recognizable', 'usmle-cardio', {
            difficulty: 'easy',
            topics: ['Blood Pressure'],
          }),
        ])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn(async (input: Step1DeliveryRow[]) => {
          rows.push(...input);
          return input.length;
        }),
        createId: idFactory('session-lay-purchase', 'delivery-lay-purchase'),
        random: () => 0.5,
      },
    );

    // Both candidates are equally easy and there is no prior ladder/domain.
    // The preferred question sorts later by id and its domain sorts later too,
    // proving that the exact topic tag — not incidental ordering — selected it.
    expect(rows[0]).toMatchObject({
      itemId: 'z-recognizable',
      queueReason: 'daily-unseen',
    });
    expect(result.items[0].stem).toBe('Clinical stem for z-recognizable');
  });

  it('fills a missing requested hook and reserves the replacement in the hook stage', async () => {
    const rows: Step1DeliveryRow[] = [];
    const result = await createStep1Session(
      {
        userId: 'guest-1',
        mode: 'daily',
        size: 3,
        now: NOW,
        prependQuestionIds: ['hook-a', 'missing-hook', 'hook-b'],
      },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('hook-a', 'usmle-cardio'),
          question('hook-b', 'usmle-renal'),
          question('fill-a', 'usmle-immunology'),
          question('fill-b', 'usmle-biochem'),
        ])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn(async (input: Step1DeliveryRow[]) => {
          rows.push(...input);
          return input.length;
        }),
        createId: idFactory('session-hook', 'd1', 'd2', 'd3'),
        random: () => 0.5,
      },
    );

    expect(rows.slice(0, 2).map((row) => row.itemId)).toEqual(['hook-a', 'hook-b']);
    expect(rows.slice(0, 2).map((row) => row.queueReason)).toEqual(['hook-v1', 'hook-v1']);
    expect(rows[2]).toMatchObject({ itemId: expect.stringMatching(/^fill-/) });
    expect(result.hookItemCount).toBe(3);
    expect(result.items).toHaveLength(3);
  });

  it('filters the fill pool by allowedDifficulties without dropping prepended hooks', async () => {
    const rows: Step1DeliveryRow[] = [];
    const result = await createStep1Session(
      {
        userId: 'guest-1',
        mode: 'daily',
        size: 4,
        now: NOW,
        prependQuestionIds: ['hook-hard'],
        allowedDifficulties: ['easy'],
      },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('hook-hard', 'usmle-cardio', { difficulty: 'hard' }),
          question('easy-a', 'usmle-renal', { difficulty: 'easy' }),
          question('easy-b', 'usmle-immunology', { difficulty: 'easy' }),
          question('hard-fill', 'usmle-biochem', { difficulty: 'hard' }),
        ])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn(async (input: Step1DeliveryRow[]) => {
          rows.push(...input);
          return input.length;
        }),
        createId: idFactory('session-band', 'd1', 'd2', 'd3', 'd4'),
        random: () => 0.5,
      },
    );

    expect(rows[0]).toMatchObject({ itemId: 'hook-hard', queueReason: 'hook-v1' });
    expect(rows.slice(1).map((row) => row.itemId).sort()).toEqual(['easy-a', 'easy-b']);
    expect(rows.map((row) => row.itemId)).not.toContain('hard-fill');
    expect(result.hookItemCount).toBe(1);
  });

  it('rejects an undersized pinned baseline rather than silently changing the assessment', async () => {
    await expect(createStep1Session(
      { userId: 'admin-1', mode: 'baseline', size: 2, now: NOW },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('only-one', 'usmle-cardio'),
        ])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn(),
        createId: idFactory('session-opaque'),
        random: () => 0.5,
      },
    )).rejects.toMatchObject({ status: 409, code: 'baseline_not_ready' });
  });
});

function storedDelivery(
  q: ReturnType<typeof question>,
  overrides: Partial<Step1StoredDelivery> = {},
): Step1StoredDelivery {
  return {
    id: 'delivery-opaque-000001',
    userId: 'admin-1',
    sessionId: 'session-opaque-000001',
    batchId: 'session-opaque-000001',
    itemType: 'question',
    itemId: 'q-answer',
    deliveryPath: 'live',
    decisionPath: 'usmle-step1-daily-v1',
    answeredAt: null,
    isCorrect: null,
    responseTimeMs: null,
    payload: {
      contract: 'usmle-step1-delivery-v2',
      mode: 'daily',
      displayToOriginal: { A: 'B', B: 'C', C: 'A', D: 'D' },
      contentHash: computeStep1QuestionContentHash(q),
      servingFingerprint: RELEASE_FINGERPRINT,
    },
    ...overrides,
  };
}

describe('answerStep1Delivery', () => {
  it('rejects a forged opaque delivery without touching the grading path', async () => {
    const recordAttempt = vi.fn();
    const result = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'usmle-step1',
        deliveryId: 'forged-delivery-000001',
        selectedDisplayLabel: 'A',
        confidence: 2,
      },
      {
        findDelivery: vi.fn().mockResolvedValue(null),
        loadCorpus: vi.fn(),
        recordAttempt,
        markDeliveryAnswered: vi.fn(),
      },
    );

    expect(result).toEqual({
      ok: false,
      status: 404,
      code: 'delivery_not_found',
      error: 'Delivery not found',
    });
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it('maps the display label server-side, persists confidence canonically, then reveals', async () => {
    const q = question('q-answer', 'usmle-cardio', {
      resolvedCitation: {
        kind: 'passage',
        title: 'Open clinical source',
        publisher: 'Public publisher',
        canonicalUrl: 'https://example.org/source',
        attribution: 'Public publisher, open source',
        licence: { id: 'cc-by-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
        passageLocator: 'Section 2',
        quote: 'A short permitted quotation.',
      },
    });
    const events: string[] = [];
    const recordAttempt = vi.fn(async () => {
      events.push('attempt');
      return {
        ok: true as const,
        isCorrect: true,
        correctOption: 'A',
        attemptNumber: 1,
        explanation: 'Untrusted stale receipt explanation',
        conceptMastery: [],
        remediationCards: [],
      };
    });
    const markDeliveryAnswered = vi.fn(async () => {
      events.push('decision');
      return 'updated' as const;
    });

    const result = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'usmle-step1',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        responseTimeMs: 12_345,
        confidence: 4,
      },
      {
        findDelivery: vi.fn().mockResolvedValue(storedDelivery(q)),
        loadCorpus: vi.fn().mockResolvedValue(corpus([q])),
        recordAttempt,
        markDeliveryAnswered,
      },
    );

    expect(recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1',
      questionId: 'q-answer',
      clientRequestId: 'delivery-opaque-000001',
      selectedOption: 'A',
      responseTimeMs: 12_345,
      confidence: 4,
      sessionType: 'usmle-daily-v1',
      correctDisplayPosition: 2,
      selectedDisplayPosition: 2,
      clientTimestampFingerprint: null,
      sessionId: 'session-opaque-000001',
      batchId: 'session-opaque-000001',
      publicUsmleDeliveryCapability: PUBLIC_USMLE_DELIVERY_WRITE_CAPABILITY,
      publicUsmleExpectedServingFingerprint: RELEASE_FINGERPRINT,
      publicUsmleExpectedCorrectOption: 'A',
      publicUsmleExpectedRotation: 'usmle-cardio',
      publicUsmleExpectedWeek: null,
      publicUsmleExpectedContext: 'Teaching explanation for q-answer',
    }));
    expect(markDeliveryAnswered).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-opaque-000001',
      isCorrect: true,
      responseTimeMs: 12_345,
    }));
    expect(events).toEqual(['attempt', 'decision']);
    expect(result).toMatchObject({
      ok: true,
      deduped: false,
      reveal: {
        deliveryId: 'delivery-opaque-000001',
        questionId: 'q-answer',
        selectedDisplayLabel: 'C',
        correctDisplayLabel: 'C',
        isCorrect: true,
        explanation: 'Teaching explanation for q-answer',
        postAnswerAlt: null,
        postAnswerSourcePageUrl: null,
        attribution: { text: 'md3 contributors', licence: 'CC-BY-4.0' },
        citation: {
          title: 'Open clinical source',
          passageLocator: 'Section 2',
          quote: 'A short permitted quotation.',
        },
      },
      background: expect.objectContaining({ questionId: 'q-answer', isCorrect: true }),
    });
    const revealKeys = result.ok ? collectKeys(result.reveal) : new Set<string>();
    expect([...revealKeys]).not.toEqual(expect.arrayContaining([
      'publicProvenance',
      'provenance',
      'sourceId',
      'passageId',
      'sourceFile',
      'citations',
    ]));
  });

  it('returns the identical reveal for an exact canonical replay', async () => {
    const q = question('q-answer', 'usmle-cardio');
    const result = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'usmle-step1',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        responseTimeMs: 12_345,
        confidence: 4,
      },
      {
        findDelivery: vi.fn().mockResolvedValue(storedDelivery(q, {
          answeredAt: new Date('2026-08-01T08:01:00Z'),
          isCorrect: true,
          responseTimeMs: 12_345,
        })),
        loadCorpus: vi.fn().mockResolvedValue(corpus([q])),
        recordAttempt: vi.fn().mockResolvedValue({
          ok: true,
          deduped: true,
          receipt: {
            isCorrect: true,
            correctOption: 'A',
            attemptNumber: 1,
            explanation: 'Teaching explanation for q-answer',
          },
        }),
        markDeliveryAnswered: vi.fn().mockResolvedValue('already-matching'),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      deduped: true,
      reveal: {
        selectedDisplayLabel: 'C',
        correctDisplayLabel: 'C',
        isCorrect: true,
      },
      background: expect.objectContaining({
        questionId: 'q-answer',
        isCorrect: true,
        skipLearningEvent: true,
        now: new Date('2026-08-01T08:01:00Z'),
      }),
    });
  });

  it('attributes a v3 Cohort delivery without trusting the answer client for surface', async () => {
    const q = question('q-answer', 'usmle-cardio');
    const legacy = storedDelivery(q);
    const recordAttempt = vi.fn().mockResolvedValue({
      ok: true,
      isCorrect: true,
      correctOption: 'A',
      attemptNumber: 1,
      explanation: 'Teaching explanation for q-answer',
      conceptMastery: [],
      remediationCards: [],
    });

    const result = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'cohort',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        responseTimeMs: 12_345,
        confidence: 4,
      },
      {
        findDelivery: vi.fn().mockResolvedValue({
          ...legacy,
          payload: {
            ...(legacy.payload as Record<string, unknown>),
            contract: 'usmle-step1-delivery-v3',
            surface: 'cohort',
          },
        }),
        loadCorpus: vi.fn().mockResolvedValue(corpus([q])),
        recordAttempt,
        markDeliveryAnswered: vi.fn().mockResolvedValue('updated'),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      background: { sessionType: 'cohort-daily-v1' },
    });
    expect(recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      sessionType: 'cohort-daily-v1',
      metadata: {
        surface: 'cohort',
        mode: 'daily',
        deliveryContract: 'usmle-step1-delivery-v3',
      },
    }));
  });

  it('releases the current manifest alt only in the revalidated Cohort answer', async () => {
    const { asset, question: q } = currentQrsVisualQuestion();
    const baseDelivery = storedDelivery(q);
    const loadCorpus = vi.fn().mockResolvedValue(corpus([q]));

    const result = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'cohort',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        confidence: 3,
        now: new Date('2026-08-14T08:00:00.000Z'),
      },
      {
        findDelivery: vi.fn().mockResolvedValue({
          ...baseDelivery,
          payload: {
            ...(baseDelivery.payload as Record<string, unknown>),
            contract: 'usmle-step1-delivery-v3',
            surface: 'cohort',
          },
        }),
        loadCorpus,
        recordAttempt: vi.fn().mockResolvedValue({
          ok: true,
          isCorrect: true,
          correctOption: 'A',
          attemptNumber: 1,
          explanation: 'A stale receipt must not supply accessibility text.',
          conceptMastery: [],
          remediationCards: [],
        }),
        markDeliveryAnswered: vi.fn().mockResolvedValue('updated'),
      },
    );

    expect(loadCorpus).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      reveal: {
        postAnswerAlt: asset.accessibility.postAnswerAlt,
        postAnswerSourcePageUrl: asset.rights.sourcePageUrl,
      },
    });
  });

  it('rejects a Cohort delivery at the canonical Step 1 answer boundary', async () => {
    const q = question('q-answer', 'usmle-cardio');
    const legacy = storedDelivery(q);
    const loadCorpus = vi.fn();
    const recordAttempt = vi.fn();

    const result = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'usmle-step1',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        responseTimeMs: 12_345,
        confidence: 4,
      },
      {
        findDelivery: vi.fn().mockResolvedValue({
          ...legacy,
          payload: {
            ...(legacy.payload as Record<string, unknown>),
            contract: 'usmle-step1-delivery-v3',
            surface: 'cohort',
          },
        }),
        loadCorpus,
        recordAttempt,
        markDeliveryAnswered: vi.fn(),
      },
    );

    expect(result).toEqual({
      ok: false,
      status: 404,
      code: 'delivery_not_found',
      error: 'Delivery not found',
    });
    expect(loadCorpus).not.toHaveBeenCalled();
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it('recovers derived background work when canonical recording commits before finalization fails', async () => {
    const q = question('q-finalization-retry', 'usmle-cardio');
    const canonicalReceipt = {
      isCorrect: true,
      correctOption: 'A',
      attemptNumber: 1,
      explanation: 'Teaching explanation for q-finalization-retry',
    };
    const recordAttempt = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        ...canonicalReceipt,
        conceptMastery: [],
        remediationCards: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        deduped: true,
        receipt: canonicalReceipt,
      });
    const markDeliveryAnswered = vi.fn()
      .mockRejectedValueOnce(new Error('temporary finalization failure'))
      .mockResolvedValueOnce('updated');
    const dependencies = {
      findDelivery: vi.fn().mockResolvedValue(storedDelivery(q, {
        itemId: 'q-finalization-retry',
      })),
      loadCorpus: vi.fn().mockResolvedValue(corpus([q])),
      recordAttempt,
      markDeliveryAnswered,
    };
    const input = {
      userId: 'admin-1',
      expectedSurface: 'usmle-step1' as const,
      deliveryId: 'delivery-opaque-000001',
      selectedDisplayLabel: 'C',
      responseTimeMs: 12_345,
      confidence: 4,
    };

    await expect(answerStep1Delivery(input, dependencies)).rejects.toMatchObject({
      status: 503,
      code: 'answer_finalization_failed',
    });
    const retry = await answerStep1Delivery(input, dependencies);

    expect(recordAttempt).toHaveBeenCalledTimes(2);
    expect(markDeliveryAnswered).toHaveBeenCalledTimes(2);
    expect(retry).toMatchObject({
      ok: true,
      deduped: true,
      background: {
        userId: 'admin-1',
        questionId: 'q-finalization-retry',
        selectedOption: 'A',
        responseTimeMs: 12_345,
        confidence: 4,
        sessionType: 'usmle-daily-v1',
        correctDisplayPosition: 2,
        selectedDisplayPosition: 2,
        isCorrect: true,
        skipLearningEvent: true,
        sessionId: 'session-opaque-000001',
        batchId: 'session-opaque-000001',
      },
    });
  });

  it('returns 409 when a consumed delivery is submitted with a changed answer', async () => {
    const q = question('q-answer', 'usmle-cardio');
    const result = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'usmle-step1',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'A',
        responseTimeMs: 12_345,
        confidence: 4,
      },
      {
        findDelivery: vi.fn().mockResolvedValue(storedDelivery(q, {
          answeredAt: new Date('2026-08-01T08:01:00Z'),
        })),
        loadCorpus: vi.fn().mockResolvedValue(corpus([q])),
        recordAttempt: vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          error: 'clientRequestId was already used for a different response',
        }),
        markDeliveryAnswered: vi.fn(),
      },
    );

    expect(result).toMatchObject({ ok: false, status: 409, code: 'delivery_already_answered' });
  });

  it('rechecks current eligibility and content integrity before grading', async () => {
    const q = question('q-answer', 'usmle-cardio');
    const recordAttempt = vi.fn();
    const common = {
      findDelivery: vi.fn().mockResolvedValue(storedDelivery(q)),
      recordAttempt,
      markDeliveryAnswered: vi.fn(),
    };

    const revoked = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'usmle-step1',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        confidence: 3,
      },
      { ...common, loadCorpus: vi.fn().mockResolvedValue(corpus([])) },
    );
    expect(revoked).toMatchObject({ ok: false, status: 410, code: 'delivery_revoked' });

    const changed = question('q-answer', 'usmle-cardio', { stem: 'Changed after delivery' });
    const stale = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'usmle-step1',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        confidence: 3,
      },
      { ...common, loadCorpus: vi.fn().mockResolvedValue(corpus([changed])) },
    );
    expect(stale).toMatchObject({ ok: false, status: 409, code: 'delivery_content_changed' });
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it('revokes a Cohort answer when its prompt visual no longer passes the manifest gate', async () => {
    const q = question('q-answer', 'usmle-cardio', {
      imageUrl: '/figures/usmle/step1/ecg-case-2w7m4q.svg',
      imageCaption: 'A diagnosis-neutral teaching strip.',
      publicProvenance: {
        ...provenance,
        media: {
          kind: 'asset',
          assetId: 'ecg-case-2w7m4q',
          job: 'trace',
          showWhen: 'always',
          licence: { cls: 'foss', id: 'cc-by-4.0' },
          attribution: 'MD3 contributors',
          contentHash: `sha256:${'f'.repeat(64)}`,
          clinicalConditionIds: ['ventricular-depolarization'],
          clinicalKeyFindings: ['The highlighted tall sharp waveform is the QRS complex'],
        },
      },
    });
    const recordAttempt = vi.fn();
    const delivery = storedDelivery(q, {
      payload: {
        contract: 'usmle-step1-delivery-v3',
        mode: 'daily',
        surface: 'cohort',
        displayToOriginal: { A: 'B', B: 'C', C: 'A', D: 'D' },
        contentHash: computeStep1QuestionContentHash(q),
        servingFingerprint: RELEASE_FINGERPRINT,
      },
    });

    const result = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'cohort',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        confidence: 3,
        now: new Date('2026-08-14T08:00:00.000Z'),
      },
      {
        findDelivery: vi.fn().mockResolvedValue(delivery),
        loadCorpus: vi.fn().mockResolvedValue(corpus([q])),
        recordAttempt,
        markDeliveryAnswered: vi.fn(),
      },
    );

    expect(result).toMatchObject({ ok: false, status: 410, code: 'delivery_revoked' });
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it('does not finalize or schedule background work when the protected writer detects a race', async () => {
    const q = question('q-answer', 'usmle-cardio');
    const markDeliveryAnswered = vi.fn();
    const result = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'usmle-step1',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        confidence: 3,
      },
      {
        findDelivery: vi.fn().mockResolvedValue(storedDelivery(q)),
        loadCorpus: vi.fn().mockResolvedValue(corpus([q])),
        recordAttempt: vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          code: 'question_content_changed',
          error: 'Question content changed after delivery',
        }),
        markDeliveryAnswered,
      },
    );

    expect(result).toEqual({
      ok: false,
      status: 409,
      code: 'delivery_content_changed',
      error: 'Question content changed after delivery',
    });
    expect(result).not.toHaveProperty('background');
    expect(markDeliveryAnswered).not.toHaveBeenCalled();
  });

  it('withholds the reveal when marking the strict ServeDecision fails', async () => {
    const q = question('q-answer', 'usmle-cardio');
    await expect(answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'usmle-step1',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        confidence: 3,
      },
      {
        findDelivery: vi.fn().mockResolvedValue(storedDelivery(q)),
        loadCorpus: vi.fn().mockResolvedValue(corpus([q])),
        recordAttempt: vi.fn().mockResolvedValue({
          ok: true,
          isCorrect: true,
          correctOption: 'A',
          attemptNumber: 1,
          explanation: 'Teaching explanation for q-answer',
          conceptMastery: [],
          remediationCards: [],
        }),
        markDeliveryAnswered: vi.fn().mockRejectedValue(new Error('write failed')),
      },
    )).rejects.toMatchObject({ status: 503, code: 'answer_finalization_failed' });
  });

  it('withholds the reveal if public eligibility is revoked during canonical grading', async () => {
    const q = question('q-answer', 'usmle-cardio');
    const loadCorpus = vi.fn()
      .mockResolvedValueOnce(corpus([q]))
      .mockResolvedValueOnce(corpus([]));
    const markDeliveryAnswered = vi.fn().mockResolvedValue('updated');

    const result = await answerStep1Delivery(
      {
        userId: 'admin-1',
        expectedSurface: 'usmle-step1',
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        confidence: 3,
      },
      {
        findDelivery: vi.fn().mockResolvedValue(storedDelivery(q)),
        loadCorpus,
        recordAttempt: vi.fn().mockResolvedValue({
          ok: true,
          isCorrect: true,
          correctOption: 'A',
          attemptNumber: 1,
          explanation: 'Teaching explanation for q-answer',
          conceptMastery: [],
          remediationCards: [],
        }),
        markDeliveryAnswered,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 410,
      code: 'delivery_revoked',
      background: expect.objectContaining({
        questionId: 'q-answer',
        isCorrect: true,
        skipLearningEvent: true,
      }),
    });
    expect(markDeliveryAnswered).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-opaque-000001',
      isCorrect: true,
    }));
  });
});

describe('getStep1Progress', () => {
  it('counts only the currently eligible corpus and emits descriptive coverage only', async () => {
    const cohortOnlyVisual = currentQrsVisualQuestion('cohort-only-visual').question;
    const loadHistory = vi.fn().mockResolvedValue([
      { questionId: 'baseline-a', isCorrect: false, createdAt: new Date('2026-07-01T00:00:00Z'), sessionType: 'usmle-baseline-v1' },
      { questionId: 'baseline-a', isCorrect: true, createdAt: new Date('2026-08-01T06:00:00Z'), sessionType: 'usmle-daily-v1' },
      { questionId: 'daily-only', isCorrect: false, createdAt: new Date('2026-08-01T07:00:00Z'), sessionType: 'usmle-daily-v1' },
      { questionId: 'cohort-only-visual', isCorrect: true, createdAt: new Date('2026-08-01T07:15:00Z'), sessionType: 'cohort-daily-v1' },
      { questionId: 'no-longer-eligible', isCorrect: true, createdAt: new Date('2026-08-01T07:30:00Z'), sessionType: 'usmle-daily-v1' },
    ]);
    const progress = await getStep1Progress(
      { userId: 'admin-1', now: NOW, timezone: 'UTC', dailyTarget: 3 },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('baseline-a', 'usmle-cardio'),
          question('baseline-b', 'usmle-renal'),
          question('daily-only', 'usmle-cardio', { moduleNodes: ['usmle/step1'] }),
          cohortOnlyVisual,
        ])),
        loadHistory,
      },
    );

    expect(progress).toMatchObject({
      corpus: { eligible: 3 },
      baseline: { total: 2, attempted: 1, correct: 1, remaining: 1, complete: false },
      coverage: { attempted: 2, unseen: 1 },
      activity: { totalAttempts: 3, correctAttempts: 1, todayAttempts: 2 },
      nextAction: 'baseline',
    });
    expect(progress.domains).toEqual(expect.arrayContaining([
      { domain: 'usmle-cardio', eligible: 2, attempted: 2, correct: 1, unseen: 0 },
      { domain: 'usmle-renal', eligible: 1, attempted: 0, correct: 0, unseen: 1 },
    ]));
    expect(loadHistory).toHaveBeenCalledWith(
      'admin-1',
      expect.not.arrayContaining(['cohort-only-visual']),
    );

    const keys = [...collectKeys(progress)].map((key) => key.toLowerCase());
    expect(keys).not.toEqual(expect.arrayContaining([
      'readiness',
      'passprobability',
      'predictedscore',
      'passlikelihood',
    ]));
  });
});

describe('Cohort transactional delivery overrides', () => {
  it('uses a stable journey id, global ordinal, and server-authored focus reason', async () => {
    const rows: Step1DeliveryRow[] = [];
    const result = await createStep1Session(
      {
        userId: 'cohort-user',
        mode: 'daily',
        size: 1,
        now: NOW,
        surface: 'cohort',
        sessionId: 'journey-stable-1',
        positionOffset: 7,
        queueReasonOverride: 'search-focus',
      },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('q-focused', 'usmle-cardio'),
        ])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn(async (input: Step1DeliveryRow[]) => {
          rows.push(...input);
          return input.length;
        }),
        createId: idFactory('delivery-focused'),
        random: () => 0,
      },
    );

    expect(result.sessionId).toBe('journey-stable-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'delivery-focused',
      sessionId: 'journey-stable-1',
      batchId: 'journey-stable-1',
      position: 7,
      queueReason: 'search-focus',
      payload: { surface: 'cohort' },
    });
  });

  it('labels a server-pinned scaffold as remediation without changing the public item shape', async () => {
    const rows: Step1DeliveryRow[] = [];
    const result = await createStep1Session(
      {
        userId: 'cohort-user',
        mode: 'daily',
        size: 1,
        now: NOW,
        surface: 'cohort',
        sessionId: 'journey-stable-2',
        prependQuestionIds: ['q-remediation'],
        prependQueueReason: 'same-concept-remediation',
      },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('q-remediation', 'usmle-cardio'),
        ])),
        loadHistory: vi.fn().mockResolvedValue([]),
        persistDeliveries: vi.fn(async (input: Step1DeliveryRow[]) => {
          rows.push(...input);
          return input.length;
        }),
        createId: idFactory('delivery-remediation'),
        random: () => 0,
      },
    );

    expect(rows[0]?.queueReason).toBe('same-concept-remediation');
    expect(result.items[0]).not.toHaveProperty('questionId');
    expect(result.items[0]).not.toHaveProperty('queueReason');
  });
});


describe('replayStep1Session', () => {
  async function fixture() {
    const q: PublicUsmleQuestion = question('replay-q', 'usmle-cardio');
    const rows: Step1DeliveryRow[] = [];
    const first = await createStep1Session({ userId: 'user-1', mode: 'daily', size: 1, now: NOW }, {
      loadCorpus: async () => corpus([q]),
      loadHistory: async () => [],
      persistDeliveries: async (batch) => { rows.push(...batch); return batch.length; },
      createId: idFactory('session-replay', 'delivery-replay'),
      random: () => 0.25,
    });
    return { q, rows, first, receipt: {
      sessionId: first.sessionId, mode: first.mode, requestedSize: 1,
      deliveryIds: first.items.map(item => item.deliveryId),
    } };
  }

  it('reconstructs exactly the original labels and safe fields from retained delivery proofs', async () => {
    const { q, rows, first, receipt } = await fixture();
    const publicFirst = { ...first };
    Reflect.deleteProperty(publicFirst, 'hookItemCount');
    expect(replayStep1Session(receipt, rows, corpus([q]))).toEqual(publicFirst);
  });

  it.each(['removed', 'changed', 'fingerprint', 'surface', 'mapping', 'missing-delivery'])(
    'rejects a %s delivery instead of reissuing its content', async (kind) => {
      const { q, rows, receipt } = await fixture();
      const changed = { ...q };
      if (kind === 'changed') changed.stem += ' changed';
      if (kind === 'fingerprint') changed.releaseFingerprint = 'b'.repeat(64);
      if (kind === 'surface') rows[0].payload.surface = 'cohort';
      if (kind === 'mapping') rows[0].payload.displayToOriginal = { A: 'Z', B: 'Y', C: 'X', D: 'W' };
      expect(() => replayStep1Session(receipt,
        kind === 'missing-delivery' ? [] : rows,
        corpus(kind === 'removed' ? [] : [changed]),
      )).toThrow();
    },
  );
});
