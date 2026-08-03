/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-utils', () => ({ requireAuthOrExistingGuest: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkUserRateLimit: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@/lib/question-analytics', () => ({ updateQuestionAnalytics: vi.fn() }));
vi.mock('@/lib/review/post-commit', () => ({
  dispatchPostCommit: vi.fn(async ({
    tasks,
    scheduler,
  }: {
    tasks: Array<{ run: () => Promise<unknown> }>;
    scheduler?: (work: () => Promise<void>) => void;
  }) => {
    const work = async () => { await Promise.all(tasks.map((task) => task.run())); };
    if (scheduler) scheduler(work);
    else await work();
  }),
}));
vi.mock('@/lib/review/record-question-attempt', () => ({
  recordQuestionAttemptBackground: vi.fn(),
}));
vi.mock('@/lib/usmle/step1-session.server', () => ({
  answerStep1Delivery: vi.fn(),
  Step1ApiError: class Step1ApiError extends Error {},
}));
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return {
    ...actual,
    after: vi.fn((callback: () => Promise<void>) => void callback()),
  };
});

import { requireAuthOrExistingGuest } from '@/lib/api-utils';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { updateQuestionAnalytics } from '@/lib/question-analytics';
import { dispatchPostCommit } from '@/lib/review/post-commit';
import { recordQuestionAttemptBackground } from '@/lib/review/record-question-attempt';
import { answerStep1Delivery } from '@/lib/usmle/step1-session.server';
import { POST } from './route';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/usmle/step1/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  deliveryId: 'delivery-opaque-000001',
  selectedDisplayLabel: 'C',
  responseTimeMs: 4_200,
  confidence: 3,
};

describe('POST /api/usmle/step1/answer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuthOrExistingGuest).mockResolvedValue({
      userId: 'user-1',
      isGuest: false,
    });
    vi.mocked(checkUserRateLimit).mockResolvedValue({ ok: true });
    vi.mocked(updateQuestionAnalytics).mockResolvedValue(undefined);
    vi.mocked(recordQuestionAttemptBackground).mockResolvedValue(undefined);
    vi.mocked(answerStep1Delivery).mockResolvedValue({
      ok: true,
      deduped: false,
      reveal: {
        deliveryId: 'delivery-opaque-000001',
        questionId: 'q-answer',
        selectedDisplayLabel: 'C',
        correctDisplayLabel: 'C',
        isCorrect: true,
        attemptNumber: 1,
        explanation: 'Explanation',
        optionExplanations: [],
        attribution: { text: 'md3 contributors', licence: 'CC-BY-4.0' },
        citation: null,
      },
      background: {
        userId: 'user-1',
        questionId: 'q-answer',
        selectedOption: 'A',
        responseTimeMs: 4_200,
        sessionType: 'usmle-daily-v1',
        correctDisplayPosition: 2,
        selectedDisplayPosition: 2,
        confidence: 3,
        isCorrect: true,
        skipLearningEvent: true,
        sessionId: 'session-opaque',
        batchId: 'session-opaque',
        now: new Date('2026-08-01T08:01:00Z'),
      },
    });
  });

  it('rejects answer writes without a session or existing guest cookie', async () => {
    vi.mocked(requireAuthOrExistingGuest).mockResolvedValue({
      response: NextResponse.json(
        { error: 'Authentication required — load the app first to establish a session' },
        { status: 401 },
      ),
    });

    const response = await POST(request(validBody));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(answerStep1Delivery).not.toHaveBeenCalled();
  });

  it('fails closed under the shared per-user limiter', async () => {
    vi.mocked(checkUserRateLimit).mockResolvedValue({
      ok: false,
      retryAfterMs: 1_200,
      reason: 'store_unavailable',
    });

    const response = await POST(request(validBody));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(answerStep1Delivery).not.toHaveBeenCalled();
  });

  it('applies the tighter guest answer budget', async () => {
    vi.mocked(requireAuthOrExistingGuest).mockResolvedValue({
      userId: 'guest-1',
      isGuest: true,
    });

    const response = await POST(request(validBody));

    expect(response.status).toBe(200);
    expect(checkUserRateLimit).toHaveBeenCalledWith(
      'guest-1',
      'usmle-step1-answer',
      20,
      60_000,
    );
  });

  it('accepts only the opaque answer contract and schedules derived work after success', async () => {
    const response = await POST(request(validBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(body).toMatchObject({ deduped: false, answer: { isCorrect: true } });
    expect(body).not.toHaveProperty('background');
    expect(checkUserRateLimit).toHaveBeenCalledWith(
      'user-1',
      'usmle-step1-answer',
      60,
      60_000,
    );
    expect(answerStep1Delivery).toHaveBeenCalledWith({
      userId: 'user-1',
      ...validBody,
    });
    expect(dispatchPostCommit).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'usmle-step1-answer',
      context: expect.objectContaining({
        userId: 'user-1',
        questionId: 'q-answer',
        deliveryId: 'delivery-opaque-000001',
      }),
      scheduler: expect.any(Function),
      tasks: [
        expect.objectContaining({ name: 'question-analytics' }),
        expect.objectContaining({ name: 'question-attempt-derived-state' }),
      ],
    }));
    expect(updateQuestionAnalytics).toHaveBeenCalledWith('q-answer');
    expect(recordQuestionAttemptBackground).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 'q-answer', skipLearningEvent: true }),
    );
  });

  it('rejects answer-bearing or caller-authored routing fields', async () => {
    for (const extra of [
      { questionId: 'q-answer' },
      { selectedOption: 'A' },
      { clientRequestId: 'caller-controlled' },
      { correctDisplayPosition: 0 },
      { sessionType: 'exam-sim' },
    ]) {
      const response = await POST(request({ ...validBody, ...extra }));
      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(answerStep1Delivery).not.toHaveBeenCalled();
  });

  it('requires pre-reveal confidence in the bounded 1..4 scale', async () => {
    for (const confidence of [undefined, 0, 5, 2.5]) {
      const response = await POST(request({ ...validBody, confidence }));
      expect(response.status).toBe(400);
    }
    expect(answerStep1Delivery).not.toHaveBeenCalled();
  });

  it('bounds response time to one day so it remains valid Prisma Int telemetry', async () => {
    for (const responseTimeMs of [-1, 86_400_001, Number.MAX_SAFE_INTEGER]) {
      const response = await POST(request({ ...validBody, responseTimeMs }));
      expect(response.status).toBe(400);
    }
    expect(answerStep1Delivery).not.toHaveBeenCalled();
  });

  it('reruns idempotent background work for an exact replay', async () => {
    vi.mocked(answerStep1Delivery).mockResolvedValue({
      ok: true,
      deduped: true,
      reveal: {
        deliveryId: 'delivery-opaque-000001',
        questionId: 'q-answer',
        selectedDisplayLabel: 'C',
        correctDisplayLabel: 'C',
        isCorrect: true,
        attemptNumber: 1,
        explanation: 'Explanation',
        optionExplanations: [],
        attribution: { text: 'md3 contributors', licence: 'CC-BY-4.0' },
        citation: null,
      },
      background: {
        userId: 'user-1',
        questionId: 'q-answer',
        selectedOption: 'A',
        responseTimeMs: 4_200,
        sessionType: 'usmle-daily-v1',
        correctDisplayPosition: 2,
        selectedDisplayPosition: 2,
        confidence: 3,
        isCorrect: true,
        skipLearningEvent: true,
        sessionId: 'session-opaque',
        batchId: 'session-opaque',
        now: new Date('2026-08-01T08:01:00Z'),
      },
    });

    const response = await POST(request(validBody));

    expect(response.status).toBe(200);
    expect(dispatchPostCommit).toHaveBeenCalledOnce();
    expect(updateQuestionAnalytics).toHaveBeenCalledWith('q-answer');
    expect(recordQuestionAttemptBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: 'q-answer',
        skipLearningEvent: true,
        now: new Date('2026-08-01T08:01:00Z'),
      }),
    );
  });

  it('propagates a changed-answer conflict without a reveal', async () => {
    vi.mocked(answerStep1Delivery).mockResolvedValue({
      ok: false,
      status: 409,
      code: 'delivery_already_answered',
      error: 'Delivery was already answered differently',
    });

    const response = await POST(request(validBody));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Delivery was already answered differently',
      code: 'delivery_already_answered',
    });
    expect(updateQuestionAnalytics).not.toHaveBeenCalled();
  });

  it('rolls forward idempotent derived work when eligibility is revoked after commit', async () => {
    vi.mocked(answerStep1Delivery).mockResolvedValue({
      ok: false,
      status: 410,
      code: 'delivery_revoked',
      error: 'This delivery is no longer eligible',
      background: {
        userId: 'user-1',
        questionId: 'q-answer',
        selectedOption: 'A',
        responseTimeMs: 4_200,
        sessionType: 'usmle-daily-v1',
        correctDisplayPosition: 2,
        selectedDisplayPosition: 2,
        confidence: 3,
        isCorrect: true,
        skipLearningEvent: true,
        sessionId: 'session-opaque',
        batchId: 'session-opaque',
        now: new Date('2026-08-01T08:01:00Z'),
      },
    });

    const response = await POST(request(validBody));

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: 'This delivery is no longer eligible',
      code: 'delivery_revoked',
    });
    expect(dispatchPostCommit).toHaveBeenCalledOnce();
    expect(recordQuestionAttemptBackground).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: 'q-answer', skipLearningEvent: true }),
    );
  });
});
