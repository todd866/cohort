import { after, NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthOrExistingGuest } from '@/lib/api-utils';
import { logger } from '@/lib/logger';
import { updateQuestionAnalytics } from '@/lib/question-analytics';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { dispatchPostCommit } from '@/lib/review/post-commit';
import { recordQuestionAttemptBackground } from '@/lib/review/record-question-attempt';
import {
  STEP1_ANSWER_LIMIT,
  STEP1_RATE_WINDOW_MS,
  step1RateLimit,
} from '@/lib/usmle/step1-rate-limits';
import {
  answerStep1Delivery,
  Step1ApiError,
} from '@/lib/usmle/step1-session.server';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
} as const;

const answerSchema = z.object({
  deliveryId: z.string().trim().min(10).max(128).regex(/^[a-z0-9_-]+$/i),
  selectedDisplayLabel: z.string().trim().regex(/^[a-z]$/i).transform((value) => value.toUpperCase()).nullable(),
  responseTimeMs: z.number().int().min(0).max(86_400_000).optional(),
  confidence: z.number().int().min(1).max(4),
}).strict();

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control']);
  response.headers.append('Vary', 'Cookie');
  return response;
}

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { ...PRIVATE_HEADERS, ...headers },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuthOrExistingGuest();
  if (auth.response) return privateResponse(auth.response);

  const limit = step1RateLimit(auth.isGuest, STEP1_ANSWER_LIMIT);
  const rateLimit = await checkUserRateLimit(
    auth.userId,
    'usmle-step1-answer',
    limit,
    STEP1_RATE_WINDOW_MS,
  );
  if (!rateLimit.ok) {
    return json(
      { error: 'Too many requests' },
      429,
      { 'Retry-After': String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000))) },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = answerSchema.safeParse(rawBody);
  if (!parsed.success) {
    return json(
      { error: 'Invalid answer request', details: parsed.error.flatten().fieldErrors },
      400,
    );
  }

  try {
    const result = await answerStep1Delivery({
      userId: auth.userId,
      ...parsed.data,
    });

    if (result.background) {
      const background = result.background;
      await dispatchPostCommit({
        owner: 'usmle-step1-answer',
        context: {
          userId: auth.userId,
          questionId: background.questionId,
          deliveryId: parsed.data.deliveryId,
        },
        scheduler: (work) => after(work),
        tasks: [
          {
            name: 'question-analytics',
            run: () => updateQuestionAnalytics(background.questionId),
          },
          {
            name: 'question-attempt-derived-state',
            run: () => recordQuestionAttemptBackground(background),
          },
        ],
      });
    }

    if (!result.ok) {
      return json({ error: result.error, code: result.code }, result.status);
    }

    return json({ deduped: result.deduped, answer: result.reveal });
  } catch (error) {
    if (error instanceof Step1ApiError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    logger.error('USMLE Step 1 answer failed', {
      userId: auth.userId,
      error: String(error),
    });
    return json({ error: 'Could not record the Step 1 answer' }, 500);
  }
}
