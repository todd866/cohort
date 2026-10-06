import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthOrExistingGuest } from '@/lib/api-utils';
import { isCohortHostname } from '@/lib/institution';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { recordCohortFeedback, COHORT_FEEDBACK_RATINGS, COHORT_FEEDBACK_REASONS } from '@/lib/cohort/feedback.server';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Host' } as const;
const common = { deliveryId: z.string().trim().min(10).max(128).regex(/^[a-z0-9_-]+$/i), clientRequestId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/) };
const schema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('rating'), rating: z.enum(COHORT_FEEDBACK_RATINGS) }).strict(),
  z.object({ ...common, kind: z.literal('flag'), reason: z.enum(COHORT_FEEDBACK_REASONS), message: z.string().max(1000).optional() }).strict(),
]);
export async function POST(request: NextRequest) {
  if (!isCohortHostname(new URL(request.url).hostname)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const auth = await requireAuthOrExistingGuest();
  if (auth.response) { auth.response.headers.set('Cache-Control', headers['Cache-Control']); return auth.response; }
  const limit = await checkUserRateLimit(auth.userId, 'cohort-feedback', 30, 60_000);
  if (!limit.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { ...headers, 'Retry-After': String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))) } });
  let raw: unknown; try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers }); }
  const parsed = schema.safeParse(raw); if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers });
  try {
    const result = await recordCohortFeedback({ userId: auth.userId, ...parsed.data });
    return NextResponse.json(result.body, { status: result.status, headers });
  } catch {
    return NextResponse.json({ error: 'Could not save feedback' }, { status: 503, headers });
  }
}
