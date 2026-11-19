import { NextRequest } from 'next/server';
import { getUnifiedSession, type UnifiedSessionAuthOverride, type UnifiedSessionOptions } from './unified-session-service';

/**
 * Review must always serve. Session prep narrows a plain feed to the deck for
 * an upcoming session; once that deck is spent the narrowed request returns no
 * items, and the learner met "Session complete" with the rest of the rotation
 * untouched (10 Nov 2026). When an automatic-prep-eligible request comes back
 * empty, ask again with prep off: the ordinary feed. The second build runs only
 * when the first was empty.
 */
export async function getUnifiedSessionNeverEmptyForPrep(
  request: NextRequest,
  authOverride?: UnifiedSessionAuthOverride,
  options: UnifiedSessionOptions = {},
): ReturnType<typeof getUnifiedSession> {
  const first = await getUnifiedSession(request, authOverride, options);
  if (!options.resolvePrepWeek && !options.resolvePresentationPrepReoffer) return first;
  const url = new URL(request.url);
  if (url.searchParams.get('prep') === 'off' || !first.ok || typeof first.clone !== 'function') return first;
  const body = await Promise.resolve().then(() => first.clone().json()).catch(() => null) as { items?: unknown; decisionPath?: unknown } | null;
  if (!body || !Array.isArray(body.items) || body.items.length > 0) return first;
  // The terminal rescue already widened prep and searched the active decks.
  if (body.decisionPath === 'fallback-never-empty') return first;
  url.searchParams.set('prep', 'off');
  return getUnifiedSession(new NextRequest(url, { headers: request.headers }), authOverride, options);
}
