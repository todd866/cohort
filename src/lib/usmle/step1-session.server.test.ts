import { describe, expect, it, vi } from 'vitest';
import {
  USMLE_STEP1_BASELINE_MODULE,
  answerStep1Delivery,
  computeStep1QuestionContentHash,
  createStep1Session,
  getStep1Progress,
  type Step1DeliveryRow,
  type Step1StoredDelivery,
} from './step1-session.server';
import { PUBLIC_USMLE_DELIVERY_WRITE_CAPABILITY } from '@/lib/review/record-question-attempt';

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

function corpus(questions: ReturnType<typeof question>[]) {
  return { questions, decisions: [] };
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
      contract: 'usmle-step1-delivery-v2',
      mode: 'baseline',
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
        deliveryId: 'delivery-opaque-000001',
        selectedDisplayLabel: 'C',
        confidence: 3,
      },
      { ...common, loadCorpus: vi.fn().mockResolvedValue(corpus([changed])) },
    );
    expect(stale).toMatchObject({ ok: false, status: 409, code: 'delivery_content_changed' });
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it('does not finalize or schedule background work when the protected writer detects a race', async () => {
    const q = question('q-answer', 'usmle-cardio');
    const markDeliveryAnswered = vi.fn();
    const result = await answerStep1Delivery(
      {
        userId: 'admin-1',
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
    const progress = await getStep1Progress(
      { userId: 'admin-1', now: NOW, timezone: 'UTC', dailyTarget: 3 },
      {
        loadCorpus: vi.fn().mockResolvedValue(corpus([
          question('baseline-a', 'usmle-cardio'),
          question('baseline-b', 'usmle-renal'),
          question('daily-only', 'usmle-cardio', { moduleNodes: ['usmle/step1'] }),
        ])),
        loadHistory: vi.fn().mockResolvedValue([
          { questionId: 'baseline-a', isCorrect: false, createdAt: new Date('2026-07-01T00:00:00Z'), sessionType: 'usmle-baseline-v1' },
          { questionId: 'baseline-a', isCorrect: true, createdAt: new Date('2026-08-01T06:00:00Z'), sessionType: 'usmle-daily-v1' },
          { questionId: 'daily-only', isCorrect: false, createdAt: new Date('2026-08-01T07:00:00Z'), sessionType: 'usmle-daily-v1' },
          { questionId: 'no-longer-eligible', isCorrect: true, createdAt: new Date('2026-08-01T07:30:00Z'), sessionType: 'usmle-daily-v1' },
        ]),
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

    const keys = [...collectKeys(progress)].map((key) => key.toLowerCase());
    expect(keys).not.toEqual(expect.arrayContaining([
      'readiness',
      'passprobability',
      'predictedscore',
      'passlikelihood',
    ]));
  });
});
