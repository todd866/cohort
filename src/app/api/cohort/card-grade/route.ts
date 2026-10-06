import { after, NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAuthOrExistingGuest } from '@/lib/api-utils';
import { gradeCohortCard } from '@/lib/cohort/card-grade.server';
import { CohortTurnError, serveCohortTurn, type CohortTurnRequest } from '@/lib/cohort/cohort-turn.server';
import { parseTurnBody } from '@/lib/cohort/turn-request.server';
import { isCohortHostname } from '@/lib/institution';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { STEP1_ANSWER_LIMIT, STEP1_RATE_WINDOW_MS, STEP1_SESSION_LIMIT, step1RateLimit } from '@/lib/usmle/step1-rate-limits';

/**
 * Grade a Cohort module card (Increment 3, docs/designs/2026-09-23-cohort-mirror.md).
 * Cohort host only. An existing guest may grade, as with the module MCQs, but
 * this route never mints one: the turn that delivered the card already did.
 */

const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Host' } as const;

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...PRIVATE_HEADERS, ...headers } });
}

const gradeSchema = z.object({
  deliveryId: z.string().trim().min(10).max(128).regex(/^[a-z0-9_-]+$/i),
  confidence: z.number().int().min(1).max(4),
  clientRequestId: z.string().trim().min(1).max(128),
  responseTimeMs: z.number().int().min(0).max(86_400_000).optional(),
  nextTurn: z.unknown().optional(),
}).strict();

export async function POST(request: NextRequest) {
  if (!isCohortHostname(new URL(request.url).hostname)) return json({ error: 'Not found' }, 404);

  const auth = await requireAuthOrExistingGuest();
  if (auth.response) {
    auth.response.headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control']);
    return auth.response;
  }

  const limit = await checkUserRateLimit(
    auth.userId,
    'cohort-card-grade',
    step1RateLimit(auth.isGuest, STEP1_ANSWER_LIMIT),
    STEP1_RATE_WINDOW_MS,
  );
  if (!limit.ok) {
    return json({ error: 'Too many requests' }, 429, {
      'Retry-After': String(Math.max(1, Math.ceil(limit.retryAfterMs / 1_000))),
    });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = gradeSchema.safeParse(raw);
  if (!parsed.success) return json({ error: 'Invalid grade' }, 400);

  let nextTurn: CohortTurnRequest | undefined;
  if (parsed.data.nextTurn !== undefined) {
    const parsedTurn = parseTurnBody(parsed.data.nextTurn);
    if (!parsedTurn.ok) return json({ error: 'Invalid next turn request', code: parsedTurn.code }, 400);
    if (parsedTurn.value.previousDeliveryId !== parsed.data.deliveryId) {
      return json({ error: 'Next turn must continue the graded delivery', code: 'invalid_previous_delivery' }, 400);
    }
    nextTurn = parsedTurn.value;
  }

  const result = await gradeCohortCard(
    { userId: auth.userId, deliveryId: parsed.data.deliveryId, confidence: parsed.data.confidence, clientRequestId: parsed.data.clientRequestId, responseTimeMs: parsed.data.responseTimeMs },
    { schedulePostCommit: (work) => { after(work); } },
  );
  if (result.status !== 200 || !nextTurn || 'revoked' in result.body) return json(result.body, result.status);

  try {
    const continuation = await serveCohortTurn(
      { userId: auth.userId, ...nextTurn },
      {
        authorizeRequest: async (kind) => {
          const turnLimit = step1RateLimit(auth.isGuest, STEP1_SESSION_LIMIT);
          const rateLimit = await checkUserRateLimit(
            auth.userId,
            kind === 'replay' ? 'cohort-turn-replay' : 'cohort-turn',
            kind === 'replay' ? turnLimit * 4 : turnLimit,
            STEP1_RATE_WINDOW_MS,
          );
          return rateLimit.ok ? { ok: true } : { ok: false, retryAfterMs: rateLimit.retryAfterMs };
        },
      },
    );
    return json({ ...result.body, nextTurn: continuation.response }, 200);
  } catch (error) {
    // The grade is already committed. The client must retain the same turn
    // receipt and retry /api/cohort/turn independently rather than replaying
    // or reporting a failed grade.
    if (!(error instanceof CohortTurnError)) console.error('Cohort continuation failed after grade', error);
    return json(result.body, 200);
  }
}
