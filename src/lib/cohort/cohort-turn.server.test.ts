/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createStep1Session: vi.fn(),
  cohortPromptMediaForQuestion: vi.fn(),
  anatomyCardMediaForStableId: vi.fn(),
  loadCorpus: vi.fn(),
  loadCards: vi.fn(),
}));

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  syncOperation: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  user: { findUnique: vi.fn() },
  serveDecision: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    createMany: vi.fn(),
  },
  learningEvent: { create: vi.fn() },
  feedEvent: { create: vi.fn() },
  cardProgress: { findMany: vi.fn() },
  questionResponse: { findMany: vi.fn() },
  question: { findMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    syncOperation: { findUnique: vi.fn() },
  },
}));

// The turn loads the Cohort corpus (Step 1 + mirrored modules) through one seam.
vi.mock('./module-question-corpus.server', () => ({
  loadCohortServableCorpus: mocks.loadCorpus,
}));
// The module card corpus is one seam too; the card SELECTION stays real.
vi.mock('./module-card-corpus.server', async () => ({
  ...(await vi.importActual<typeof import('./module-card-corpus.server')>('./module-card-corpus.server')),
  loadCohortModuleCardCorpus: mocks.loadCards,
}));
vi.mock('./anatomy-card-media', () => ({
  anatomyCardMediaForStableId: mocks.anatomyCardMediaForStableId,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/usmle/public-question-corpus.server', () => ({
  loadPublicUsmleQuestionCorpus: mocks.loadCorpus,
}));

vi.mock('@/lib/usmle/step1-session.server', () => ({
  cohortPromptMediaForQuestion: mocks.cohortPromptMediaForQuestion,
  createStep1Session: mocks.createStep1Session,
  computeStep1QuestionContentHash: vi.fn(() => 'b'.repeat(64)),
  isDeliverableStep1Question: vi.fn(() => true),
  Step1ApiError: class Step1ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { prisma } from '@/lib/prisma';
import type { PublicUsmleQuestion } from '@/lib/usmle/public-question-corpus.server';
import { resolveCohortSearchTopic } from './search-topic-registry.server';
import { parseCohortFeedProfile } from './feed-profile';
import { COHORT_HOOK_V1_IDS } from './hook-playlist';
import {
  buildCohortSelectionPlan,
  buildCohortTurnFingerprint,
  CohortTurnError,
  serveCohortTurn,
} from './cohort-turn.server';
import {
  computeStep1QuestionContentHash,
  type Step1DeliveryRow,
} from '@/lib/usmle/step1-session.server';

const NOW = new Date('2026-08-14T08:00:00.000Z');
const RELEASE_FINGERPRINT = 'a'.repeat(64);

const provenance = {
  schemaVersion: 1,
  origin: 'authored',
  itemText: { licence: 'CC-BY-4.0', attribution: 'md3 contributors' },
  evidence: { kind: 'none' },
} as const;

function question(
  id: string,
  difficulty = 'medium',
  topics: string[] = ['usmle-step1'],
  overrides: Record<string, unknown> = {},
): PublicUsmleQuestion {
  return {
    id,
    stem: `Clinical stem for ${id}`,
    options: [
      { label: 'A', text: 'Correct', isCorrect: true, explanation: 'Why A.' },
      { label: 'B', text: 'Distractor', isCorrect: false, explanation: 'Why B.' },
      { label: 'C', text: 'Distractor', isCorrect: false },
      { label: 'D', text: 'Distractor', isCorrect: false },
    ],
    context: `Teaching context for ${id}`,
    rotation: 'usmle-cardio',
    week: null,
    topics,
    moduleNodes: ['usmle/step1', 'usmle/step1/cardiovascular'],
    questionType: 'mechanism',
    difficulty,
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
  } as unknown as PublicUsmleQuestion;
}

const session = {
  sessionId: 'journey-1',
  mode: 'daily' as const,
  requestedSize: 1,
  deliveredSize: 1,
  items: [{
    deliveryId: 'delivery-1',
    stem: 'Clinical stem for q-focus',
    options: [
      { label: 'A', text: 'Correct' },
      { label: 'B', text: 'Distractor' },
      { label: 'C', text: 'Distractor' },
      { label: 'D', text: 'Distractor' },
    ],
    domain: 'usmle/step1/cardiovascular',
    difficulty: 'medium',
    questionType: 'mechanism',
    attribution: { text: 'md3 contributors', licence: 'CC-BY-4.0' },
  }],
};

const baseInput = {
  userId: 'user-1',
  serveRequestId: 'serve-request-1',
  journeyId: 'journey-1',
  nextDrawOrdinal: 0,
  timezone: 'Australia/Perth',
  searchTopicId: 'heart-function' as const,
  now: NOW,
};

describe('buildCohortSelectionPlan', () => {
  it('keeps the fixed hook ahead of a selected search topic', () => {
    const topic = resolveCohortSearchTopic('heart-function')!;
    const hookIds = [...COHORT_HOOK_V1_IDS];
    const plan = buildCohortSelectionPlan({
      questions: [
        ...hookIds.map((id) => question(id)),
        question('q-focus', 'medium', ['heart failure']),
      ],
      history: [],
      profile: parseCohortFeedProfile(null),
      searchTopic: topic,
    });

    expect(plan.stage).toBe('hook');
    expect(plan.turnSize).toBe(3);
    expect(plan.prependQuestionIds).toEqual(hookIds);
    expect(plan.queueReason).toBe('hook-v1');
  });

  it('puts immediate same-ladder remediation ahead of a conflicting hard focus', () => {
    const missed = question('q-ladder-hard', 'hard', ['ladder:cardiac-output']);
    const remediation = question('q-ladder-medium', 'medium', ['ladder:cardiac-output']);
    const focus = question('q-focus', 'medium', ['heart failure']);
    const plan = buildCohortSelectionPlan({
      questions: [missed, remediation, focus],
      history: [{
        questionId: missed.id,
        isCorrect: false,
        createdAt: NOW,
        sessionType: 'cohort-daily-v1',
      }],
      profile: parseCohortFeedProfile({
        hookCompletedAt: '2026-08-14T00:00:00.000Z',
        explicit: { experience: 'medical-student' },
      }),
      searchTopic: resolveCohortSearchTopic('heart-function')!,
    });

    expect(plan).toMatchObject({
      stage: 'remediation',
      turnSize: 1,
      prependQuestionIds: ['q-ladder-medium'],
      queueReason: 'same-concept-remediation',
    });
    expect(plan.questions.map((candidate) => candidate.id)).toEqual(['q-ladder-medium']);
  });

  it('uses exact registry tags as a hard focus and reports exhaustion without fallback', () => {
    const profile = parseCohortFeedProfile({
      hookCompletedAt: '2026-08-14T00:00:00.000Z',
      explicit: { experience: 'medical-student' },
    });
    const focused = buildCohortSelectionPlan({
      questions: [
        question('q-focus', 'medium', ['heart failure']),
        question('q-unrelated', 'medium', ['renal physiology']),
      ],
      history: [],
      profile,
      searchTopic: resolveCohortSearchTopic('heart-function')!,
    });
    expect(focused.stage).toBe('search-focus');
    expect(focused.questions.map((candidate) => candidate.id)).toEqual(['q-focus']);
    expect(focused.queueReason).toBe('search-focus');

    expect(() => buildCohortSelectionPlan({
      questions: [question('q-unrelated', 'medium', ['renal physiology'])],
      history: [],
      profile,
      searchTopic: resolveCohortSearchTopic('heart-function')!,
    })).toThrowError(expect.objectContaining({
      status: 409,
      code: 'topic_exhausted',
    }));
  });

  it('keeps the mirrored modules out of the Step 1 feed and serves one only when it is chosen', () => {
    const profile = parseCohortFeedProfile({
      hookCompletedAt: '2026-08-14T00:00:00.000Z',
      explicit: { experience: 'medical-student' },
    });
    const module = (id: string, discipline: string, topics = ['heart failure']) => question(id, 'medium', topics, {
      rotation: 'cohort-open', moduleNodes: [`cohort/${discipline}`],
    });
    const questions = [
      question('q-step1', 'medium', ['heart failure']),
      module('bank:cohort:paeds:q-000000000001:v1', 'paeds'),
      module('bank:cohort:resp:q-000000000002:v1', 'resp'),
    ];

    const discovery = buildCohortSelectionPlan({ questions, history: [], profile, searchTopic: null });
    expect(discovery.questions.map((q) => q.id)).toEqual(['q-step1']);

    // A Step 1 topic whose tag a module item also carries still serves Step 1 only.
    const step1Focus = buildCohortSelectionPlan({
      questions, history: [], profile, searchTopic: resolveCohortSearchTopic('heart-function')!,
    });
    expect(step1Focus.questions.map((q) => q.id)).toEqual(['q-step1']);

    const paeds = buildCohortSelectionPlan({
      questions, history: [], profile, searchTopic: resolveCohortSearchTopic('module-paeds')!,
    });
    expect(paeds.stage).toBe('search-focus');
    expect(paeds.questions.map((q) => q.id)).toEqual(['bank:cohort:paeds:q-000000000001:v1']);
  });

  it('applies the experience rung after topic matching', () => {
    const plan = buildCohortSelectionPlan({
      questions: [
        question('q-easy', 'easy', ['heart failure']),
        question('q-hard', 'hard', ['heart failure']),
      ],
      history: [],
      profile: parseCohortFeedProfile({
        hookCompletedAt: '2026-08-14T00:00:00.000Z',
        explicit: { experience: 'high-school' },
      }),
      searchTopic: resolveCohortSearchTopic('heart-function')!,
    });
    expect(plan.questions.map((candidate) => candidate.id)).toEqual(['q-easy']);
  });

  it('returns topic_exhausted when recent focused items are suppressed', () => {
    const focused = question('q-focus', 'medium', ['heart failure'], {
      variantGroupId: 'recent-family',
      variantType: 'near-duplicate',
    });
    const sibling = question('q-focus-sibling', 'medium', ['heart failure'], {
      variantGroupId: 'recent-family',
      variantType: 'near-duplicate',
    });
    expect(() => buildCohortSelectionPlan({
      questions: [focused, sibling],
      history: [{
        questionId: focused.id,
        isCorrect: true,
        createdAt: NOW,
        sessionType: 'cohort-daily-v1',
      }],
      profile: parseCohortFeedProfile({
        hookCompletedAt: '2026-08-14T00:00:00.000Z',
        explicit: { experience: 'medical-student' },
      }),
      searchTopic: resolveCohortSearchTopic('heart-function')!,
      now: NOW,
    })).toThrowError(expect.objectContaining({
      status: 409,
      code: 'topic_exhausted',
    }));
  });
});

describe('serveCohortTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation((async (
      callback: (client: typeof tx) => unknown,
    ) => callback(tx)) as never);
    vi.mocked(prisma.syncOperation.findUnique).mockResolvedValue(null as never);
    tx.$queryRaw.mockResolvedValue([{ id: 'user-1' }]);
    tx.syncOperation.findUnique.mockResolvedValue(null);
    tx.syncOperation.create.mockResolvedValue({ id: 'operation-1' });
    tx.syncOperation.update.mockResolvedValue({});
    tx.user.findUnique.mockResolvedValue({
      feedProfile: {
        hookCompletedAt: '2026-08-14T00:00:00.000Z',
        explicit: { experience: 'medical-student' },
      },
    });
    tx.serveDecision.findFirst.mockResolvedValue(null);
    tx.serveDecision.findMany.mockResolvedValue([]);
    tx.serveDecision.count.mockResolvedValue(0);
    tx.serveDecision.createMany.mockResolvedValue({ count: 1 });
    tx.learningEvent.create.mockResolvedValue({ id: 'continue-event-1' });
    tx.questionResponse.findMany.mockResolvedValue([]);
    mocks.loadCorpus.mockResolvedValue({
      questions: [question('q-focus', 'medium', ['heart failure'])],
      decisions: [],
    });
    mocks.createStep1Session.mockResolvedValue({ ...session, hookItemCount: 0 });
    mocks.cohortPromptMediaForQuestion.mockReturnValue(undefined);
  });

  it('fingerprints every immutable body field, including search focus', () => {
    const fingerprint = buildCohortTurnFingerprint(baseInput);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(buildCohortTurnFingerprint({
      ...baseInput,
      searchTopicId: 'blood-pressure',
    })).not.toBe(fingerprint);
    expect(buildCohortTurnFingerprint({
      ...baseInput,
      now: new Date('2030-01-01T00:00:00.000Z'),
    })).toBe(fingerprint);
  });

  it('returns a policy receipt for confirmed +2 exhaustion without creating a delivery', async () => {
    tx.user.findUnique.mockResolvedValue({
      feedProfile: { hookCompletedAt: '2026-08-14T00:00:00.000Z', explicit: { experience: 'medical-student' } },
      reviewChallenge: 2,
      reviewChallengeRevision: 7,
    });
    const result = await serveCohortTurn({ ...baseInput, searchTopicId: undefined });
    expect(result.response).toMatchObject({
      requestedSize: 1,
      deliveredSize: 0,
      items: [],
      reviewChallengeExhausted: { level: 2, revision: 7, policy: expect.any(String) },
    });
    expect(tx.serveDecision.createMany).not.toHaveBeenCalled();
    expect(tx.syncOperation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'completed', result: expect.objectContaining({ deliveredSize: 0 }) }),
    }));
  });

  it('replays a confirmed empty receipt without minting a delivery or duplicate demand', async () => {
    const empty = { ...session, deliveredSize: 0, items: [], reviewChallengeExhausted: {
      level: 2, revision: 7, policy: 'review-challenge-v2',
    } };
    tx.syncOperation.findUnique.mockResolvedValue({ operationType: 'cohort_serve', status: 'completed',
      requestFingerprint: buildCohortTurnFingerprint(baseInput), result: empty });
    await expect(serveCohortTurn(baseInput)).resolves.toEqual({ response: empty, deduped: true });
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(tx.serveDecision.createMany).not.toHaveBeenCalled();
    expect(tx.feedEvent.create).not.toHaveBeenCalled();
    expect(tx.learningEvent.create).not.toHaveBeenCalled();
  });

  it('Step 1 hard demand excludes mirrored module questions with overlapping tags', async () => {
    tx.user.findUnique.mockResolvedValue({ feedProfile: { hookCompletedAt: NOW.toISOString(), explicit: {} },
      reviewChallenge: 2, reviewChallengeRevision: 7 });
    const missed = question('q-miss', 'easy', ['heart failure']);
    const moduleHard = question('q-module-hard', 'hard', ['heart failure'], { rotation: 'cohort-open', moduleNodes: ['cohort/paeds'] });
    mocks.loadCorpus.mockResolvedValue({ questions: [missed, moduleHard], decisions: [] });
    tx.questionResponse.findMany.mockResolvedValue([{ questionId: missed.id, isCorrect: false,
      createdAt: NOW, sessionType: 'cohort-daily-v1' }]);
    const result = await serveCohortTurn(baseInput);
    expect(result.response.items).toEqual([]);
    expect(tx.feedEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      metadata: { schemaVersion: 1, surface: 'cohort', topics: [{ topic: 'heart failure', unseenHard: 0, targetUnseenHard: 15, deficit: 15 }] },
    }) }));
  });

  it('locks the user, atomically writes the delivery, and freezes the opaque response', async () => {
    const authorizeRequest = vi.fn().mockResolvedValue({ ok: true });
    const deliveryRow = {
      id: 'delivery-1',
      userId: 'user-1',
      sessionId: 'journey-1',
    } as Step1DeliveryRow;
    mocks.createStep1Session.mockImplementationOnce(async (input, dependencies) => {
      await dependencies.persistDeliveries?.([deliveryRow]);
      return { ...session, hookItemCount: 0 };
    });

    const result = await serveCohortTurn(baseInput, { authorizeRequest });

    expect(result).toEqual({ response: session, deduped: false });
    expect(authorizeRequest).toHaveBeenCalledWith('new');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.syncOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        clientOperationId: 'serve-request-1',
        operationType: 'cohort_serve',
        status: 'pending',
        requestFingerprint: buildCohortTurnFingerprint(baseInput),
      }),
      select: { id: true },
    });
    expect(mocks.createStep1Session).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        mode: 'daily',
        size: 1,
        surface: 'cohort',
        sessionId: 'journey-1',
        positionOffset: 0,
        queueReasonOverride: 'search-focus',
      }),
      expect.objectContaining({
        loadCorpus: expect.any(Function),
        loadHistory: expect.any(Function),
        persistDeliveries: expect.any(Function),
      }),
    );
    expect(tx.serveDecision.createMany).toHaveBeenCalledWith({
      data: [{
        ...deliveryRow,
        payload: { searchTopicId: 'heart-function' },
      }],
    });
    expect(tx.learningEvent.create).not.toHaveBeenCalled();
    expect(tx.syncOperation.update).toHaveBeenCalledWith({
      where: { id: 'operation-1' },
      data: { status: 'completed', result: session },
    });
    expect(tx.syncOperation.create.mock.invocationCallOrder[0])
      .toBeLessThan(tx.serveDecision.createMany.mock.invocationCallOrder[0]);
    expect(tx.serveDecision.createMany.mock.invocationCallOrder[0])
      .toBeLessThan(tx.syncOperation.update.mock.invocationCallOrder[0]);
  });

  it('replays a matching completed operation before profile or policy reads', async () => {
    const authorizeRequest = vi.fn().mockResolvedValue({ ok: true });
    const replayQuestion = question('q-focus', 'medium', ['heart failure']);
    tx.syncOperation.findUnique.mockResolvedValueOnce({
      operationType: 'cohort_serve',
      status: 'completed',
      requestFingerprint: buildCohortTurnFingerprint(baseInput),
      result: session,
    });
    vi.mocked(prisma.syncOperation.findUnique).mockResolvedValueOnce({
      operationType: 'cohort_serve',
      status: 'completed',
      requestFingerprint: buildCohortTurnFingerprint(baseInput),
    } as never);
    tx.serveDecision.findMany.mockResolvedValueOnce([{
      id: 'delivery-1',
      itemId: 'q-focus',
      payload: {
        contract: 'usmle-step1-delivery-v3',
        surface: 'cohort',
        contentHash: computeStep1QuestionContentHash(replayQuestion),
        servingFingerprint: RELEASE_FINGERPRINT,
      },
    }]);
    mocks.loadCorpus.mockResolvedValueOnce({ questions: [replayQuestion], decisions: [] });

    await expect(serveCohortTurn(baseInput, { authorizeRequest })).resolves.toEqual({
      response: session,
      deduped: true,
    });
    expect(authorizeRequest).toHaveBeenCalledWith('replay');
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
    expect(tx.syncOperation.create).not.toHaveBeenCalled();
  });

  it('strictly replays answer-safe prompt media without exposing hook internals', async () => {
    const mediaSession = {
      ...session,
      items: [{
        ...session.items[0],
        media: {
          imageUrl: '/figures/usmle/step1/ecg-wave-components-v1.svg',
          preAnswerAlt: 'Schematic lead II rhythm strip with one complex highlighted.',
          class: 'diagnostic',
          showWhen: 'always',
          modality: 'ecg',
          attributionText: 'Lehman et al. via PhysioNet; Lead II excerpt rendered by MD3 contributors — CC BY-SA 4.0',
          licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        },
      }],
    };
    mocks.cohortPromptMediaForQuestion.mockReturnValueOnce(mediaSession.items[0].media);
    tx.syncOperation.findUnique.mockResolvedValueOnce({
      operationType: 'cohort_serve',
      status: 'completed',
      requestFingerprint: buildCohortTurnFingerprint(baseInput),
      result: mediaSession,
    });
    tx.serveDecision.findMany.mockResolvedValueOnce([{
      id: 'delivery-1',
      itemId: 'q-focus',
      payload: {
        contract: 'usmle-step1-delivery-v3',
        surface: 'cohort',
        contentHash: 'b'.repeat(64),
        servingFingerprint: RELEASE_FINGERPRINT,
      },
    }]);

    await expect(serveCohortTurn(baseInput)).resolves.toEqual({
      response: mediaSession,
      deduped: true,
    });
    expect(mediaSession).not.toHaveProperty('hookItemCount');
  });

  it('revokes a frozen visual replay whose HTTPS source page was forged', async () => {
    const currentMedia = {
      imageUrl: '/figures/usmle/step1/ecg-case-2w7m4q.svg',
      preAnswerAlt: 'A diagnosis-neutral tracing description.',
      class: 'diagnostic' as const,
      showWhen: 'always' as const,
      modality: 'ecg' as const,
      attributionText: 'Wagner et al. via PhysioNet; Lead II excerpt rendered by MD3 contributors — CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      sourcePageUrl: 'https://physionet.org/content/ptb-xl/1.0.3/',
    };
    const forgedSession = {
      ...session,
      items: [{
        ...session.items[0],
        media: {
          ...currentMedia,
          sourcePageUrl: 'https://example.invalid/forged-source',
        },
      }],
    };
    tx.syncOperation.findUnique.mockResolvedValueOnce({
      operationType: 'cohort_serve',
      status: 'completed',
      requestFingerprint: buildCohortTurnFingerprint(baseInput),
      result: forgedSession,
    });
    tx.serveDecision.findMany.mockResolvedValueOnce([{
      id: 'delivery-1',
      itemId: 'q-focus',
      payload: {
        contract: 'usmle-step1-delivery-v3',
        surface: 'cohort',
        contentHash: 'b'.repeat(64),
        servingFingerprint: RELEASE_FINGERPRINT,
      },
    }]);
    mocks.cohortPromptMediaForQuestion.mockReturnValueOnce(currentMedia);

    await expect(serveCohortTurn(baseInput)).rejects.toMatchObject({
      status: 410,
      code: 'delivery_revoked',
    });
  });

  it('rejects a frozen visual receipt carrying an extra URL field', async () => {
    const mediaSession = {
      ...session,
      items: [{
        ...session.items[0],
        media: {
          imageUrl: '/figures/usmle/step1/ecg-case-2w7m4q.svg',
          preAnswerAlt: 'A diagnosis-neutral tracing description.',
          class: 'diagnostic',
          showWhen: 'always',
          modality: 'ecg',
          attributionText: 'Wagner et al. via PhysioNet; Lead II excerpt rendered by MD3 contributors — CC BY 4.0',
          licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
          sourcePageUrl: 'https://physionet.org/content/ptb-xl/1.0.3/',
          downloadUrl: 'https://example.invalid/unreviewed-download',
        },
      }],
    };
    tx.syncOperation.findUnique.mockResolvedValueOnce({
      operationType: 'cohort_serve',
      status: 'completed',
      requestFingerprint: buildCohortTurnFingerprint(baseInput),
      result: mediaSession,
    });

    await expect(serveCohortTurn(baseInput)).rejects.toMatchObject({
      status: 503,
      code: 'serve_receipt_unavailable',
    });
    expect(tx.serveDecision.findMany).not.toHaveBeenCalled();
  });

  it('revokes a frozen visual replay when its current manifest admission disappears', async () => {
    const mediaSession = {
      ...session,
      items: [{
        ...session.items[0],
        media: {
          imageUrl: '/figures/usmle/step1/ecg-case-2w7m4q.svg',
          preAnswerAlt: 'A diagnosis-neutral tracing description.',
          class: 'diagnostic',
          showWhen: 'always',
          modality: 'ecg',
          attributionText: 'Wagner et al. via PhysioNet; Lead II excerpt rendered by MD3 contributors — CC BY 4.0',
          licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
          sourcePageUrl: 'https://physionet.org/content/ptb-xl/1.0.3/',
        },
      }],
    };
    tx.syncOperation.findUnique.mockResolvedValueOnce({
      operationType: 'cohort_serve',
      status: 'completed',
      requestFingerprint: buildCohortTurnFingerprint(baseInput),
      result: mediaSession,
    });
    tx.serveDecision.findMany.mockResolvedValueOnce([{
      id: 'delivery-1',
      itemId: 'q-focus',
      payload: {
        contract: 'usmle-step1-delivery-v3',
        surface: 'cohort',
        contentHash: 'b'.repeat(64),
        servingFingerprint: RELEASE_FINGERPRINT,
      },
    }]);
    mocks.cohortPromptMediaForQuestion.mockReturnValueOnce(undefined);

    await expect(serveCohortTurn(baseInput)).rejects.toMatchObject({
      status: 410,
      code: 'delivery_revoked',
    });
  });

  it('replays a frozen request after its topic leaves the current registry', async () => {
    const removedTopicInput = { ...baseInput, searchTopicId: 'removed-topic' };
    tx.syncOperation.findUnique.mockResolvedValueOnce({
      operationType: 'cohort_serve',
      status: 'completed',
      requestFingerprint: buildCohortTurnFingerprint(removedTopicInput),
      result: session,
    });
    tx.serveDecision.findMany.mockResolvedValueOnce([{
      id: 'delivery-1',
      itemId: 'q-focus',
      payload: {
        contract: 'usmle-step1-delivery-v3',
        surface: 'cohort',
        contentHash: 'b'.repeat(64),
        servingFingerprint: RELEASE_FINGERPRINT,
      },
    }]);

    await expect(serveCohortTurn(removedTopicInput)).resolves.toEqual({
      response: session,
      deduped: true,
    });
    expect(tx.syncOperation.create).not.toHaveBeenCalled();
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
  });

  it('rejects same-key body drift and rights-revoked replays without replacement writes', async () => {
    tx.syncOperation.findUnique.mockResolvedValueOnce({
      operationType: 'cohort_serve',
      status: 'completed',
      requestFingerprint: 'f'.repeat(64),
      result: session,
    });
    await expect(serveCohortTurn(baseInput)).rejects.toMatchObject({
      status: 409,
      code: 'serve_request_conflict',
    });

    tx.syncOperation.findUnique.mockResolvedValueOnce({
      operationType: 'cohort_serve',
      status: 'completed',
      requestFingerprint: buildCohortTurnFingerprint(baseInput),
      result: session,
    });
    tx.serveDecision.findMany.mockResolvedValueOnce([]);
    await expect(serveCohortTurn(baseInput)).rejects.toMatchObject({
      status: 410,
      code: 'delivery_revoked',
    });
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
    expect(tx.syncOperation.create).not.toHaveBeenCalled();
  });

  it('rejects a currently forged topic before an operation or delivery write', async () => {
    await expect(serveCohortTurn({
      ...baseInput,
      searchTopicId: 'forged-topic',
    })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_search_topic',
    });
    expect(tx.syncOperation.create).not.toHaveBeenCalled();
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
    expect(tx.serveDecision.createMany).not.toHaveBeenCalled();
  });

  it('returns the current ordinal after a competing journey draw wins', async () => {
    tx.serveDecision.findFirst.mockResolvedValueOnce({ position: 0 });

    try {
      await serveCohortTurn({ ...baseInput, nextDrawOrdinal: 0 });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(CohortTurnError);
      expect(error).toMatchObject({
        status: 409,
        code: 'journey_ordinal_conflict',
        details: { currentOrdinal: 1 },
      });
    }
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
  });

  it('rejects an unanswered or cross-journey Continue predecessor', async () => {
    tx.serveDecision.findFirst.mockImplementation(async (args) => (
      args?.where?.id
        ? {
            id: 'delivery-previous',
            userId: 'user-1',
            sessionId: 'other-journey',
            position: 0,
            answeredAt: null,
            payload: { surface: 'cohort' },
          }
        : { position: 0 }
    ));

    await expect(serveCohortTurn({
      ...baseInput,
      nextDrawOrdinal: 1,
      previousDeliveryId: 'delivery-previous',
    })).rejects.toMatchObject({
      status: 409,
      code: 'invalid_previous_delivery',
    });
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
  });

  it('records a fulfilled Continue in the same transaction as its next delivery', async () => {
    mocks.loadCorpus.mockResolvedValueOnce({
      questions: [
        question('q-focus', 'medium', ['heart failure']),
        question('q-next', 'medium', ['heart failure']),
      ],
      decisions: [],
    });
    const nextDelivery = {
      id: 'delivery-next',
      userId: 'user-1',
      sessionId: 'journey-1',
      payload: {},
    } as Step1DeliveryRow;
    mocks.createStep1Session.mockImplementationOnce(async (_input, dependencies) => {
      await dependencies.persistDeliveries?.([nextDelivery]);
      return { ...session, hookItemCount: 0 };
    });
    tx.serveDecision.findFirst.mockImplementation(async (args) => (
      args?.where?.id
        ? {
            id: 'delivery-previous',
            userId: 'user-1',
            sessionId: 'journey-1',
            position: 0,
            itemId: 'q-focus',
            answeredAt: NOW,
            isCorrect: true,
            payload: {
              contract: 'usmle-step1-delivery-v3',
              surface: 'cohort',
              contentHash: 'b'.repeat(64),
              servingFingerprint: RELEASE_FINGERPRINT,
            },
          }
        : { position: 0 }
    ));

    await serveCohortTurn({
      ...baseInput,
      nextDrawOrdinal: 1,
      previousDeliveryId: 'delivery-previous',
    });

    expect(tx.serveDecision.createMany).toHaveBeenCalledTimes(1);
    expect(tx.learningEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        eventType: 'cohort_continue',
        sourceType: 'delivery',
        sourceId: 'delivery-previous',
        clientOperationId: 'cohort:delivery-previous:continue-fulfilled:v1',
        conceptIds: [],
        metadata: {
          schemaVersion: 1,
          surface: 'cohort',
          journeyId: 'journey-1',
          previousDrawOrdinal: 0,
          nextDrawOrdinal: 1,
        },
        timestamp: NOW,
        receivedAt: NOW,
      }),
      select: { id: true },
    });
    expect(tx.serveDecision.createMany.mock.invocationCallOrder[0])
      .toBeLessThan(tx.learningEvent.create.mock.invocationCallOrder[0]);
    expect(tx.learningEvent.create.mock.invocationCallOrder[0])
      .toBeLessThan(tx.syncOperation.update.mock.invocationCallOrder[0]);
  });

  it('does not advance beyond a hook unit with an earlier unanswered delivery', async () => {
    tx.serveDecision.findFirst.mockImplementation(async (args) => (
      args?.where?.id
        ? {
            id: 'delivery-hook-3',
            userId: 'user-1',
            sessionId: 'journey-1',
            position: 2,
            itemId: 'q-focus',
            answeredAt: NOW,
            isCorrect: true,
            payload: {
              contract: 'usmle-step1-delivery-v3',
              surface: 'cohort',
              contentHash: 'b'.repeat(64),
              servingFingerprint: RELEASE_FINGERPRINT,
            },
          }
        : { position: 2 }
    ));
    tx.serveDecision.count.mockResolvedValueOnce(1);

    await expect(serveCohortTurn({
      ...baseInput,
      nextDrawOrdinal: 3,
      previousDeliveryId: 'delivery-hook-3',
    })).rejects.toMatchObject({
      status: 409,
      code: 'incomplete_previous_deliveries',
    });
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
    expect(tx.learningEvent.create).not.toHaveBeenCalled();
  });
});

describe('serveCohortTurn: module cards', () => {
  const card = (n: number) => ({
    id: `card-row-${n}`,
    stableId: `cohort:paeds:c-${String(n).padStart(12, '0')}:v1`,
    discipline: 'paeds',
    front: `Paediatric fact ${n} is [___].`,
    back: `answer ${n}`,
    context: `Why fact ${n} matters.`,
    variantGroupId: null,
    releaseFingerprint: 'f'.repeat(64),
    contentHash: 'c'.repeat(64),
  });
  const moduleQuestion = question('bank:cohort:paeds:q-000000000001:v1', 'medium', ['croup'], {
    rotation: 'cohort-open', moduleNodes: ['cohort/paeds'],
  });
  const moduleInput = { ...baseInput, searchTopicId: 'module-paeds' as const };
  const previousOf = (kind: 'question' | 'card') => ({
    id: 'delivery-previous',
    userId: 'user-1',
    sessionId: 'journey-1',
    position: 0,
    itemId: kind === 'card' ? 'card-row-9' : moduleQuestion.id,
    itemType: kind,
    answeredAt: NOW,
    isCorrect: true,
    payload: kind === 'card'
      ? { contract: 'cohort-module-card-v1', surface: 'cohort', discipline: 'paeds', contentHash: 'c'.repeat(64), servingFingerprint: 'f'.repeat(64) }
      : { contract: 'usmle-step1-delivery-v3', surface: 'cohort', contentHash: 'b'.repeat(64), servingFingerprint: RELEASE_FINGERPRINT },
  });
  const continued = (kind: 'question' | 'card') => {
    tx.serveDecision.findFirst.mockImplementation(async (args) => (args?.where?.id ? previousOf(kind) : { position: 0 }));
    return { ...moduleInput, nextDrawOrdinal: 1, previousDeliveryId: 'delivery-previous' };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation((async (callback: (client: typeof tx) => unknown) => callback(tx)) as never);
    vi.mocked(prisma.syncOperation.findUnique).mockResolvedValue(null as never);
    tx.$queryRaw.mockResolvedValue([{ id: 'user-1' }]);
    tx.syncOperation.findUnique.mockResolvedValue(null);
    tx.syncOperation.create.mockResolvedValue({ id: 'operation-1' });
    tx.syncOperation.update.mockResolvedValue({});
    tx.user.findUnique.mockResolvedValue({
      feedProfile: { hookCompletedAt: '2026-08-14T00:00:00.000Z', explicit: { experience: 'medical-student' } },
    });
    tx.serveDecision.findFirst.mockResolvedValue(null);
    tx.serveDecision.findMany.mockResolvedValue([]);
    tx.serveDecision.count.mockResolvedValue(0);
    tx.serveDecision.createMany.mockResolvedValue({ count: 1 });
    tx.learningEvent.create.mockResolvedValue({ id: 'continue-event-1' });
    tx.questionResponse.findMany.mockResolvedValue([]);
    tx.cardProgress.findMany.mockResolvedValue([]);
    mocks.loadCorpus.mockResolvedValue({ questions: [moduleQuestion], decisions: [] });
    mocks.loadCards.mockResolvedValue({ cards: [card(1), card(2)], refused: [] });
    mocks.createStep1Session.mockResolvedValue({ ...session, hookItemCount: 0 });
    mocks.cohortPromptMediaForQuestion.mockReturnValue(undefined);
    mocks.anatomyCardMediaForStableId.mockImplementation((stableId: string) => {
      if (stableId === 'cohort:anatomy:c-dd0bcce3d72d:v1') {
        return {
          figureId: 'abducens-local', target: 'lateral-rectus', role: 'prompt',
          preAnswerAlt: 'Prompt figure', postAnswerAlt: 'Answer figure',
        };
      }
      if (stableId === 'cohort:anatomy:c-supplementary:v1') {
        return {
          figureId: 'abducens-local', target: 'abducens', role: 'supplementary',
          preAnswerAlt: 'Supplementary figure', postAnswerAlt: 'Supplementary answer figure',
        };
      }
      return undefined;
    });
  });

  const setDifficulty = (level: number) => tx.user.findUnique.mockResolvedValue({
    feedProfile: { hookCompletedAt: '2026-08-14T00:00:00.000Z', explicit: { experience: 'medical-student' } },
    reviewChallenge: level, reviewChallengeRevision: 7,
  });

  it('Foundations discovers only C1 cards across released modules', async () => {
    setDifficulty(-2);
    mocks.loadCards.mockResolvedValue({ cards: [{ ...card(1), complexity: 2 }, { ...card(2), complexity: 1 }], refused: [] });
    const result = await serveCohortTurn({ ...baseInput, searchTopicId: undefined });
    expect(result.response.items[0]).toMatchObject({ kind: 'card', front: card(2).front });
    expect(mocks.loadCards).toHaveBeenCalledWith(tx, undefined);
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
  });

  it('opens a first anatomy visit with a reviewed illustrated card and leaves the hook untouched', async () => {
    tx.user.findUnique.mockResolvedValue({ feedProfile: null, reviewChallenge: 0, reviewChallengeRevision: 0 });
    const reviewed = {
      ...card(1),
      stableId: 'cohort:anatomy:c-dd0bcce3d72d:v1',
      discipline: 'anatomy',
      front: 'The lateral rectus is supplied by which cranial nerve? [___]',
      back: 'CN VI (abducens)',
    };
    const unrelated = { ...reviewed, id: 'card-row-unrelated', stableId: 'cohort:anatomy:c-000000000000:v1' };
    mocks.loadCards.mockResolvedValue({ cards: [unrelated, reviewed], refused: [] });

    const result = await serveCohortTurn({ ...baseInput, searchTopicId: 'module-anatomy', now: NOW });

    expect(result.response.items).toHaveLength(1);
    expect(result.response.items[0]).toMatchObject({
      kind: 'card',
      front: reviewed.front,
      media: {
        figureId: 'abducens-local',
        target: 'lateral-rectus',
        role: 'prompt',
        preAnswerAlt: expect.not.stringMatching(/CN ?VI|sixth nerve/i),
      },
    });
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
    expect(tx.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('does not force a supplementary-only figure into the first anatomy draw', async () => {
    tx.user.findUnique.mockResolvedValue({ feedProfile: null, reviewChallenge: 0, reviewChallengeRevision: 0 });
    const supplementary = {
      ...card(1),
      id: 'card-row-supplementary',
      stableId: 'cohort:anatomy:c-supplementary:v1',
      discipline: 'anatomy',
    };
    const prompt = {
      ...card(2),
      id: 'card-row-prompt',
      stableId: 'cohort:anatomy:c-dd0bcce3d72d:v1',
      discipline: 'anatomy',
    };
    mocks.loadCards.mockResolvedValue({ cards: [supplementary, prompt], refused: [] });

    const result = await serveCohortTurn({ ...baseInput, searchTopicId: 'module-anatomy', now: NOW });

    expect(result.response.items[0]).toMatchObject({ kind: 'card', deliveryId: expect.any(String) });
    expect(result.response.items[0]).not.toMatchObject({ id: supplementary.id });
    expect(result.response.items[0]).toMatchObject({ media: { role: 'prompt' } });
  });

  it('keeps a later anatomy draw on reviewed cards even when the hook is incomplete', async () => {
    tx.user.findUnique.mockResolvedValue({ feedProfile: null, reviewChallenge: 0, reviewChallengeRevision: 0 });
    mocks.loadCards.mockResolvedValue({ cards: [{ ...card(1), discipline: 'anatomy', stableId: 'cohort:anatomy:c-dd0bcce3d72d:v1' }], refused: [] });
    tx.serveDecision.findFirst.mockImplementation(async (args) => args?.where?.id ? {
      id: 'delivery-previous', userId: 'user-1', sessionId: 'journey-1', position: 0,
      itemId: 'card-row-previous', itemType: 'card', answeredAt: NOW, isCorrect: true,
      payload: { contract: 'cohort-module-card-v1', surface: 'cohort', discipline: 'anatomy', contentHash: 'c'.repeat(64), servingFingerprint: 'f'.repeat(64) },
    } : { position: 0 });
    const result = await serveCohortTurn({ ...baseInput, searchTopicId: 'module-anatomy', nextDrawOrdinal: 1, previousDeliveryId: 'delivery-previous' });
    expect(result.response.items[0]).toMatchObject({ kind: 'card', media: { target: 'lateral-rectus' } });
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
  });

  it('alternates to an anatomy question after a visual card without requiring the unrelated hook', async () => {
    tx.user.findUnique.mockResolvedValue({ feedProfile: null, reviewChallenge: 0, reviewChallengeRevision: 0 });
    const anatomyQuestion = question('anatomy-applied', 'easy', ['anatomy'], { rotation: 'cohort-open', moduleNodes: ['cohort/anatomy'] });
    mocks.loadCorpus.mockResolvedValue({ questions: [anatomyQuestion], decisions: [] });
    tx.serveDecision.findFirst.mockImplementation(async (args) => args?.where?.id ? {
      id: 'delivery-previous', userId: 'user-1', sessionId: 'journey-1', position: 0,
      itemId: 'card-row-previous', itemType: 'card', answeredAt: NOW, isCorrect: true,
      payload: { contract: 'cohort-module-card-v1', surface: 'cohort', discipline: 'anatomy', contentHash: 'c'.repeat(64), servingFingerprint: 'f'.repeat(64) },
    } : { position: 0 });
    await serveCohortTurn({ ...baseInput, searchTopicId: 'module-anatomy', nextDrawOrdinal: 1, previousDeliveryId: 'delivery-previous' });
    expect(mocks.createStep1Session).toHaveBeenCalled();
    const dependencies = mocks.createStep1Session.mock.calls.at(-1)![1];
    expect((await dependencies.loadCorpus()).questions.map((item: PublicUsmleQuestion) => item.id)).toEqual(['anatomy-applied']);
    expect(mocks.loadCards).not.toHaveBeenCalled();
  });

  it('continues with an anatomy question when a later card turn is exhausted', async () => {
    tx.user.findUnique.mockResolvedValue({ feedProfile: null, reviewChallenge: 0, reviewChallengeRevision: 0 });
    mocks.loadCards.mockResolvedValue({ cards: [], refused: [] });
    mocks.loadCorpus.mockResolvedValue({ questions: [question('anatomy-fallback', 'easy', ['anatomy'], { rotation: 'cohort-open', moduleNodes: ['cohort/anatomy'] })], decisions: [] });
    tx.serveDecision.findFirst.mockImplementation(async (args) => args?.where?.id ? previousOf('question') : { position: 0 });
    await serveCohortTurn({ ...baseInput, searchTopicId: 'module-anatomy', nextDrawOrdinal: 1, previousDeliveryId: 'delivery-previous' });
    expect(mocks.createStep1Session).toHaveBeenCalled();
    const dependencies = mocks.createStep1Session.mock.calls.at(-1)![1];
    expect((await dependencies.loadCorpus()).questions.map((item: PublicUsmleQuestion) => item.id)).toEqual(['anatomy-fallback']);
  });

  it('uses the full admitted anatomy corpus after the illustrated first entry', async () => {
    tx.user.findUnique.mockResolvedValue({ feedProfile: null, reviewChallenge: 0, reviewChallengeRevision: 0 });
    const illustrated = { ...card(1), id: 'card-row-illustrated', stableId: 'cohort:anatomy:c-dd0bcce3d72d:v1', discipline: 'anatomy' };
    const textOnly = { ...card(2), id: 'card-row-text-only', stableId: 'cohort:anatomy:c-04368305ce7f:v1', discipline: 'anatomy', front: 'Which ocular motor nerve is vulnerable because of its long intracranial course? [___]' };
    tx.serveDecision.findFirst.mockImplementation(async (args) => args?.where?.id ? {
      id: 'delivery-previous', userId: 'user-1', sessionId: 'journey-1', position: 0,
      itemId: illustrated.id, itemType: 'card', answeredAt: NOW, isCorrect: true,
      payload: { contract: 'cohort-module-card-v1', surface: 'cohort', discipline: 'anatomy', contentHash: 'c'.repeat(64), servingFingerprint: 'f'.repeat(64) },
    } : { position: 0 });
    mocks.loadCards.mockResolvedValue({ cards: [textOnly, illustrated], refused: [] });
    const result = await serveCohortTurn({ ...baseInput, searchTopicId: 'module-anatomy', nextDrawOrdinal: 1, previousDeliveryId: 'delivery-previous' });
    expect(result.response.items[0]).toMatchObject({ kind: 'card', deliveryId: expect.any(String), front: textOnly.front });
    expect(result.response.items[0]).not.toHaveProperty('media');
  });

  it('returns a receipt the client can ease from when hard anatomy is requested before the hook', async () => {
    tx.user.findUnique.mockResolvedValue({ feedProfile: null, reviewChallenge: 2, reviewChallengeRevision: 9 });
    const result = await serveCohortTurn({ ...baseInput, searchTopicId: 'module-anatomy' });
    expect(result.response).toMatchObject({ deliveredSize: 0, reviewChallengeExhausted: { level: 2, revision: 9 } });
    expect(tx.syncOperation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'completed' }) }));
  });

  it('does not fall back to the unrelated hook when reviewed anatomy media is exhausted', async () => {
    tx.user.findUnique.mockResolvedValue({ feedProfile: null, reviewChallenge: 0, reviewChallengeRevision: 0 });
    mocks.loadCards.mockResolvedValue({ cards: [], refused: [] });
    const result = await serveCohortTurn({ ...baseInput, searchTopicId: 'module-anatomy' });
    expect(result.response).toMatchObject({ requestedSize: 1, deliveredSize: 0, items: [] });
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
  });

  it('Foundations never broadens a chosen focus without scaffold coverage', async () => {
    setDifficulty(-2);
    await expect(serveCohortTurn(baseInput)).rejects.toMatchObject({ code: 'review_challenge_exhausted' });
    expect(mocks.loadCards).not.toHaveBeenCalled();
    expect(mocks.createStep1Session).not.toHaveBeenCalled();
  });

  it('Hardest bypasses module card alternation and passes only fresh hard gap questions', async () => {
    setDifficulty(2);
    const hard = { ...moduleQuestion, id: 'fresh-hard', difficulty: 'hard' };
    const exposed = { ...hard, id: 'already-delivered' };
    const unrelated = { ...hard, id: 'no-gap', topics: ['renal'] };
    mocks.loadCorpus.mockResolvedValue({ questions: [moduleQuestion, hard, exposed, unrelated], decisions: [] });
    tx.questionResponse.findMany.mockResolvedValue([{ questionId: moduleQuestion.id, isCorrect: false, createdAt: NOW, sessionType: 'cohort-daily-v1' }]);
    tx.serveDecision.findMany.mockResolvedValue([{ itemId: exposed.id }]);
    mocks.createStep1Session.mockImplementationOnce(async (_input, dependencies) => {
      expect((await dependencies.loadCorpus()).questions.map((q: PublicUsmleQuestion) => q.id)).toEqual([hard.id]);
      return { ...session, hookItemCount: 0 };
    });
    await serveCohortTurn(continued('question'));
    expect(mocks.loadCards).not.toHaveBeenCalled();
    expect(mocks.createStep1Session).toHaveBeenCalledWith(expect.objectContaining({ allowedDifficulties: ['hard'] }), expect.anything());
  });

  it('real Step 1 adaptive delivery cannot broaden the hard-gap corpus', async () => {
    setDifficulty(2);
    const hard = { ...moduleQuestion, id: 'fresh-hard', difficulty: 'hard' };
    const exposed = { ...hard, id: 'already-delivered' };
    const unrelated = { ...hard, id: 'no-gap', topics: ['renal'] };
    mocks.loadCorpus.mockResolvedValue({ questions: [moduleQuestion, hard, exposed, unrelated], decisions: [] });
    tx.questionResponse.findMany.mockResolvedValue([{ questionId: moduleQuestion.id, isCorrect: false,
      createdAt: NOW, sessionType: 'cohort-daily-v1' }]);
    tx.serveDecision.findMany.mockResolvedValue([{ itemId: exposed.id }]);
    const actual = await vi.importActual<typeof import('@/lib/usmle/step1-session.server')>('@/lib/usmle/step1-session.server');
    mocks.createStep1Session.mockImplementationOnce((input, dependencies) => actual.createStep1Session(input, dependencies));
    const { response } = await serveCohortTurn(continued('question'));
    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({ difficulty: 'hard', stem: hard.stem });
    expect(tx.serveDecision.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ itemId: hard.id })] });
    expect(mocks.loadCards).not.toHaveBeenCalled();
  });

  it('records exact public demand for a spent hard pool, including unanswered deliveries', async () => {
    setDifficulty(2);
    const hard = { ...moduleQuestion, id: 'already-delivered', difficulty: 'hard' };
    mocks.loadCorpus.mockResolvedValue({ questions: [moduleQuestion, hard], decisions: [] });
    tx.questionResponse.findMany.mockResolvedValue([{ questionId: moduleQuestion.id, isCorrect: false, createdAt: NOW, sessionType: 'cohort-daily-v1' }]);
    tx.serveDecision.findMany.mockResolvedValue([{ itemId: hard.id }]);
    const result = await serveCohortTurn(continued('question'));
    expect(result.response.reviewChallengeExhausted).toMatchObject({ level: 2, revision: 7 });
    expect(tx.feedEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      eventType: 'content_demand', itemId: 'cohort-review-challenge-v1', metadata: {
        schemaVersion: 1, surface: 'cohort', topics: [{ topic: 'croup', unseenHard: 0, targetUnseenHard: 15, deficit: 15 }],
      },
    }) }));
    expect(tx.learningEvent.create).not.toHaveBeenCalled();
    expect(tx.serveDecision.createMany).not.toHaveBeenCalled();
  });

  it('does not turn an incomplete hard history read into exhaustion or demand', async () => {
    setDifficulty(2);
    tx.serveDecision.findMany.mockResolvedValue(Array.from({ length: 20_001 }, () => ({ itemId: moduleQuestion.id })));
    await expect(serveCohortTurn(moduleInput)).rejects.toMatchObject({ status: 503, code: 'cohort_challenge_unavailable' });
    expect(tx.feedEvent.create).not.toHaveBeenCalled();
    expect(tx.syncOperation.update).not.toHaveBeenCalled();
  });

  it('serves a card after a module question, as an opaque self-graded item', async () => {
    const result = await serveCohortTurn(continued('question'));

    expect(mocks.createStep1Session).not.toHaveBeenCalled();
    expect(mocks.loadCards).toHaveBeenCalledWith(tx, 'paeds');
    const [{ data: [row] }] = tx.serveDecision.createMany.mock.calls[0] as [{ data: Array<Record<string, unknown>> }];
    expect(row).toMatchObject({
      userId: 'user-1', sessionId: 'journey-1', itemType: 'card', itemId: 'card-row-1', rotation: 'cohort-open',
      decisionPath: 'cohort-module-card-v1', deliveryPath: 'live', position: 1,
      payload: {
        contract: 'cohort-module-card-v1', surface: 'cohort', discipline: 'paeds',
        contentHash: 'c'.repeat(64), servingFingerprint: 'f'.repeat(64), searchTopicId: 'module-paeds',
      },
    });
    expect(result.response.items).toEqual([{
      deliveryId: row.id, kind: 'card', front: 'Paediatric fact 1 is [___].', back: 'answer 1',
      context: 'Why fact 1 matters.', domain: 'Paediatrics',
      attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
    }]);
    // The card's md3 identity never reaches the client.
    expect(JSON.stringify(result.response)).not.toMatch(/card-row|cohort:paeds:c-/);
    expect(tx.learningEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.syncOperation.update).toHaveBeenCalledWith({
      where: { id: 'operation-1' }, data: { status: 'completed', result: result.response },
    });
  });

  it('serves a module question after a card, and accepts the card as the answered predecessor', async () => {
    await serveCohortTurn(continued('card'));
    expect(mocks.createStep1Session).toHaveBeenCalledTimes(1);
    expect(mocks.loadCards).not.toHaveBeenCalled();
  });

  it('falls back to a card when the module questions are spent', async () => {
    mocks.loadCorpus.mockResolvedValue({ questions: [], decisions: [] });
    const result = await serveCohortTurn(moduleInput);
    expect(result.response.items[0]).toMatchObject({ kind: 'card' });
  });

  it('falls back to a question when no card is eligible, and is exhausted when neither is', async () => {
    mocks.loadCards.mockResolvedValue({ cards: [], refused: [] });
    mocks.loadCorpus.mockResolvedValue({
      questions: [moduleQuestion, { ...moduleQuestion, id: 'bank:cohort:paeds:q-000000000002:v1' }],
      decisions: [],
    });
    await serveCohortTurn(continued('question'));
    expect(mocks.createStep1Session).toHaveBeenCalledTimes(1);

    mocks.loadCorpus.mockResolvedValue({ questions: [], decisions: [] });
    tx.syncOperation.findUnique.mockResolvedValue(null);
    tx.serveDecision.findFirst.mockReset().mockResolvedValue(null);
    await expect(serveCohortTurn({ ...moduleInput, serveRequestId: 'serve-2' })).rejects.toMatchObject({ code: 'topic_exhausted' });
  });

  it('holds back the cards this journey just served', async () => {
    tx.serveDecision.findMany.mockResolvedValue([{ itemId: 'card-row-1' }]);
    const result = await serveCohortTurn(continued('question'));
    const [{ data: [row] }] = tx.serveDecision.createMany.mock.calls[0] as [{ data: Array<Record<string, unknown>> }];
    expect(row.itemId).toBe('card-row-2');
    expect(result.response.items[0]).toMatchObject({ front: 'Paediatric fact 2 is [___].' });
  });

  it('never offers cards outside a chosen module', async () => {
    mocks.loadCorpus.mockResolvedValue({ questions: [question('q-focus', 'medium', ['heart failure'])], decisions: [] });
    await serveCohortTurn(baseInput);
    expect(mocks.loadCards).not.toHaveBeenCalled();
  });

  it('replays a frozen card turn while the card is unchanged, and revokes it once the card drifts', async () => {
    const frozen = {
      sessionId: 'journey-1', mode: 'daily', requestedSize: 1, deliveredSize: 1,
      items: [{
        deliveryId: 'delivery-card', kind: 'card', front: 'Paediatric fact 1 is [___].', back: 'answer 1',
        context: 'Why fact 1 matters.', domain: 'Paediatrics', attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
      }],
    };
    tx.syncOperation.findUnique.mockResolvedValue({
      operationType: 'cohort_serve', status: 'completed',
      requestFingerprint: buildCohortTurnFingerprint(moduleInput), result: frozen,
    });
    tx.serveDecision.findMany.mockResolvedValue([{
      id: 'delivery-card', itemId: 'card-row-1', itemType: 'card',
      payload: { contract: 'cohort-module-card-v1', surface: 'cohort', discipline: 'paeds', contentHash: 'c'.repeat(64), servingFingerprint: 'f'.repeat(64) },
    }]);
    await expect(serveCohortTurn(moduleInput)).resolves.toEqual({ response: frozen, deduped: true });
    expect(tx.serveDecision.createMany).not.toHaveBeenCalled();

    mocks.loadCards.mockResolvedValue({ cards: [{ ...card(1), contentHash: 'd'.repeat(64) }], refused: [] });
    await expect(serveCohortTurn(moduleInput)).rejects.toMatchObject({ code: 'delivery_revoked' });
  });

  it('refuses a frozen card receipt with an extra field', async () => {
    tx.syncOperation.findUnique.mockResolvedValue({
      operationType: 'cohort_serve', status: 'completed', requestFingerprint: buildCohortTurnFingerprint(moduleInput),
      result: {
        sessionId: 'journey-1', mode: 'daily', requestedSize: 1, deliveredSize: 1,
        items: [{ deliveryId: 'd', kind: 'card', front: 'x [___]', back: 'y', context: null, domain: 'P', attribution: { text: 't', licence: 'l' }, cardId: 'leak' }],
      },
    });
    await expect(serveCohortTurn(moduleInput)).rejects.toMatchObject({ code: 'serve_receipt_unavailable' });
  });
});
