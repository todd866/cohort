import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrGuest } from '@/lib/api-utils';
import { auth as authFn } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rate-limit';
import { getRotationContent } from '@/lib/study/rotation-content-map';
import { getCommitmentProfile } from '@/lib/commitment';
import type { CommitmentLevel } from '@/lib/commitment';
import type { SessionContext, UnifiedItem } from './unified-session-types';
import { checkServedItemContract } from './served-item-contract';
import { parseBatchSize } from './unified-session-helpers';
import { ROTATION_TO_MODULES } from './unified-session-manifold-items';
import { itemMatchesModules } from '@/lib/modules/matching';
import { tryStarterSession } from './unified-session-starter';
import { tryRereviewSession } from './unified-session-rereview';
import { tryReviewFilterSession } from './unified-session-review-filter';
import { tryCachedSession } from './unified-session-cache';
import { tryInstantSession } from './unified-session-instant';
import { buildManifoldSession } from './unified-session-manifold';
import { withPrivateVideoDelivery } from './private-video-delivery';
import { PERSONAL_ROTATION_IDS } from '@/lib/rotations';
import { emailCanAccessPersonalRotation } from '@/lib/personal-rotation-access';
import {
  REVIEW_FILTERS,
  type ReviewFilter,
} from '@/lib/review/review-intent';
import { USMLE_STEP1_PRIMARY_ROTATION } from '@/lib/usmle/raw-question-boundary';

const PERSONAL_ROTATIONS = new Set<string>(PERSONAL_ROTATION_IDS);
const REVIEW_FILTER_SET = new Set<string>(REVIEW_FILTERS);

function protectPersonalRotationResponse(response: NextResponse, rotation: string): NextResponse {
  if (PERSONAL_ROTATIONS.has(rotation)) {
    response.headers.set('Cache-Control', 'private, no-store');
  }
  return response;
}

/**
 * Manifold-backed session assembly for /api/study/unified-session.
 *
 * Paths are tried in order:
 *   1. Starter session (new users with zero history)
 *   2. Cached session (warm cache hit)
 *   3. Instant session (static cards + background manifold)
 *   4. Manifold session (full scheduler computation)
 */
export function normalizeModulesFilter(rotation: string, modulesFilter: string | null): string | null {
  if (!modulesFilter) return null;

  const moduleList = modulesFilter
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);
  if (moduleList.length === 0) return null;

  const rotationModules = ROTATION_TO_MODULES[rotation] || [];
  if (rotationModules.length === 0) return moduleList.join(',');

  const overlappingModules = moduleList.filter(moduleSlug =>
    rotationModules.some(rotationModule => itemMatchesModules([rotationModule], [moduleSlug])),
  );
  if (overlappingModules.length === 0) return null;

  // Selecting a whole rotation module (e.g. "cah" or "cc") does not narrow the
  // requested rotation and should not force the expensive manifold path.
  const hasWholeRotationSelection = overlappingModules.some(moduleSlug =>
    rotationModules.every(rotationModule =>
      rotationModule === moduleSlug || rotationModule.startsWith(`${moduleSlug}/`),
    ),
  );
  if (hasWholeRotationSelection) return null;

  return overlappingModules.join(',');
}

export type UnifiedSessionAuthOverride = {
  userId: string;
  isGuest: false;
};

/**
 * Every serve lane returns through `getUnifiedSession`'s `??` chain (below) —
 * five distinct lanes are wired (`rereview`, `starter`, `cache`, `instant`,
 * `manifold`; `manifold` is called twice — the `new-only` branch and the
 * terminal fallback — but it's one lane). Enforcing the served-item contract
 * HERE covers all five — and every lane added later — from a single point. A
 * hand-maintained list of lanes would not, which is precisely how `starter`
 * stayed broken while `instant` got fixed. `checkServedItemContract`
 * (Task 4) is pure; this function owns the policy:
 *
 *  - Throw when NODE_ENV !== 'production' (dev + test), so a violation fails a
 *    test — and a dev session — loudly, naming the exact lane that produced it.
 *  - Log and pass through in production: a missing caption must never 500 a real
 *    student's session over a presentational defect.
 *
 * Scope: this choke point only sees the served response — never the source
 * content-map row each item was built from — so it can only enforce
 * `checkServedItemContract`'s SOURCE-INDEPENDENT rules (imageUrl/imageCaption/
 * imageKey shape). It deliberately calls `checkServedItemContract(item)` with
 * no `source` argument, so the `source.imageRole === 'prompt'` rule (an
 * image-as-prompt card must have resolved an image) is dead here by
 * necessity, not oversight. That rule must be enforced inside each lane,
 * where the source row is still in scope — `tryInstantSession`
 * (`unified-session-instant.ts`) already does this: it drops any prompt card
 * whose image failed to resolve rather than serving an unanswerable card.
 *
 * Cost (prod): parses the response JSON once per session (~15 items). `res.clone()`
 * reads a copy so the body returned to the client is never consumed. A real
 * NextResponse always has `.clone()`; the `typeof` guard exists only for
 * plain-object test mocks, where we read `res.json()` directly so the gate STILL
 * runs — the check is never silently skipped merely because `clone` is absent.
 *
 * Robustness: this gate exists because runtime data diverged from the
 * declared types, so it must not itself crash on malformed data. Both the
 * `items` shape check and each `checkServedItemContract` call are guarded —
 * an unverifiable or exception-throwing payload is treated as a contract
 * failure (throw outside production, log-and-pass-through in production),
 * never an uncaught exception that would 500 the session this gate was built
 * to protect.
 */
export function withContractCheck(lane: string, res: NextResponse): Promise<NextResponse>;
export function withContractCheck(lane: string, res: NextResponse | null): Promise<NextResponse | null>;
export async function withContractCheck(
  lane: string,
  res: NextResponse | null,
): Promise<NextResponse | null> {
  if (!res) return res;
  let items: UnifiedItem[] = [];
  try {
    // clone() only exists on real Responses; test mocks are plain objects, so
    // fall back to reading res directly rather than disabling the check.
    const source = typeof res.clone === 'function' ? res.clone() : res;
    ({ items = [] } = await source.json());
  } catch {
    return res; // not a JSON item payload (error / redirect response) — nothing to check
  }
  if (!Array.isArray(items)) {
    // A truthy non-array `items` (e.g. a malformed lane payload) is
    // unverifiable, not a pass — but it must not crash `.flatMap` either.
    // Treat it the same as the non-JSON catch above: pass the response
    // through untouched rather than 500 the session.
    return res;
  }
  let violations: string[];
  try {
    violations = items.flatMap((item) =>
      checkServedItemContract(item).map((v) => `${lane}: item ${item.id}: ${v}`),
    );
  } catch (err) {
    // checkServedItemContract itself threw (e.g. a non-string imageUrl) —
    // that is itself a contract failure, not a reason to crash the gate.
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(`served-item contract check threw for lane ${lane}: ${(err as Error).message}`);
    }
    logger.error('served-item contract check threw', { lane, error: (err as Error).message });
    return res;
  }
  if (violations.length === 0) return res;
  if (process.env.NODE_ENV !== 'production') {
    throw new Error(`served-item contract violated —\n${violations.join('\n')}`);
  }
  logger.error('served-item contract violated', { lane, violations });
  return res;
}

export async function getUnifiedSession(
  request: NextRequest,
  authOverride?: UnifiedSessionAuthOverride,
) {
  const t0 = performance.now();
  const { searchParams } = new URL(request.url);
  const rotation = searchParams.get('rotation');
  const sizeParam = searchParams.get('size');
  const weekParam = searchParams.get('week');
  const sessionId = randomUUID();
  const batchId = randomUUID();

  // Filter params
  const typeFilter = searchParams.get('type') as 'card' | 'question' | 'group' | null;
  const difficultyFilter = searchParams.get('difficulty') as 'easy' | 'medium' | 'hard' | null;
  const topicsFilter = searchParams.get('topics'); // comma-separated
  const modulesFilter = searchParams.get('modules'); // comma-separated module slugs
  const modeParam = searchParams.get('mode');
  const mode = modeParam === 'crunch' ? 'crunch' as const
    : modeParam === 'rereview' ? 'rereview' as const
    : undefined;
  const filterParam = searchParams.get('filter');
  const reviewFilter = filterParam && REVIEW_FILTER_SET.has(filterParam)
    ? filterParam as ReviewFilter
    : undefined;
  const feedModeParam = searchParams.get('feedMode');
  const rawFeedMode = feedModeParam === 'new-only' || reviewFilter === 'new'
    ? ('new-only' as const)
    : undefined;
  // Client-side dedup: items already in the user's current session
  const clientExcludeCards = searchParams.get('excludeCards')?.split(',').filter(Boolean) ?? [];
  const clientExcludeQuestions = searchParams.get('excludeQuestions')?.split(',').filter(Boolean) ?? [];
  // Build exclusion sets once — used by cache, instant, and manifold paths
  const clientExcludeCardSet = new Set(clientExcludeCards);
  const clientExcludeQuestionSet = new Set(clientExcludeQuestions);
  const hasClientExclusions = clientExcludeCardSet.size > 0 || clientExcludeQuestionSet.size > 0;

  if (!rotation) {
    return NextResponse.json({ error: 'rotation is required' }, { status: 400 });
  }
  if (rotation === USMLE_STEP1_PRIMARY_ROTATION) {
    return NextResponse.json(
      { error: 'Rotation not found' },
      {
        status: 404,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  }

  const batchSize = parseBatchSize(sizeParam);
  const week = weekParam ? parseInt(weekParam, 10) : null;
  const weekFilter = Number.isFinite(week) ? week : null;

  // Warm the Neon connection pool in parallel with auth (prevents cold start penalty)
  const warmupPromise = prisma.$queryRaw`SELECT 1`.catch(() => {});

  let authResult: { userId: string; isGuest: boolean };
  if (authOverride) {
    authResult = authOverride;
  } else {
    const resolvedAuth = await requireAuthOrGuest(request);
    if (resolvedAuth.response) return resolvedAuth.response;
    authResult = resolvedAuth;
  }

  // Detect stale-session fallback: if auth() returned null but a session cookie
  // exists, the DB lookup likely failed (Neon cold start / timeout). Wait for the
  // pool warmup to complete, then retry auth() once. This prevents authenticated
  // users from silently getting empty guest sessions.
  if (!authOverride && authResult.isGuest) {
    const cookieName = process.env.NODE_ENV === 'production'
      ? '__Secure-next-auth.session-token'
      : 'next-auth.session-token';
    const cookieHeader = request.headers.get('cookie') ?? '';
    const hasSessionCookie = cookieHeader.includes(cookieName);

    if (hasSessionCookie) {
      // Ensure pool is warm before retrying
      await warmupPromise;
      const retrySession = await authFn();
      if (retrySession?.user?.id) {
        // Retry recovered — the guest row created by requireAuthOrGuest is
        // orphaned. Delete it so ghost-guest counts reflect real anonymous
        // visitors, not transient auth failures. Best-effort; guarded on the
        // guest signature so a real user row can never be collateral damage.
        const orphanGuestId = authResult.userId;
        await prisma.user
          .deleteMany({ where: { id: orphanGuestId, email: null, name: 'Guest' } })
          .catch(() => {});
        authResult = { userId: retrySession.user.id, isGuest: false };
        logger.warn('auth-retry-recovered', {
          userId: retrySession.user.id,
          endpoint: 'unified-session',
          rotation,
        });
      } else {
        logger.warn('auth-retry-failed', {
          endpoint: 'unified-session',
          rotation,
        });
        // Cookie exists but session is truly invalid (expired or deleted)
        return NextResponse.json(
          { error: 'Authentication required', detail: 'Your session has expired — please sign in again' },
          { status: 401 },
        );
      }
    }
  }

  // Personal rotations are intentionally undiscoverable unless the signed-in
  // user's persisted module entitlements include the requested rotation. Keep
  // this server-side and fail closed so a forged route cannot bypass the UI.
  if (PERSONAL_ROTATIONS.has(rotation)) {
    if (authResult.isGuest) {
      return protectPersonalRotationResponse(
        NextResponse.json({ error: 'Rotation not found' }, { status: 404 }),
        rotation,
      );
    }

    const entitlement = await prisma.user.findUnique({
      where: { id: authResult.userId },
      select: { email: true, activeModules: true },
    }).catch(() => null);

    if (
      !entitlement ||
      !emailCanAccessPersonalRotation(rotation, entitlement.email) ||
      !entitlement.activeModules.includes(rotation)
    ) {
      return protectPersonalRotationResponse(
        NextResponse.json({ error: 'Rotation not found' }, { status: 404 }),
        rotation,
      );
    }
  }

  const rotationContent = await getRotationContent(rotation);

  const userId = authResult.userId;
  const anonymousSessionId = authResult.isGuest ? userId : undefined;
  const tAuthEnd = performance.now();

  // Fetch commitment level in parallel with warmup (needs userId from auth)
  const commitmentPromise: Promise<CommitmentLevel> = authResult.isGuest
    ? Promise.resolve('visitor' as CommitmentLevel)
    : getCommitmentProfile(userId).then(r => r.level).catch(() => 'browser' as CommitmentLevel);

  if (authResult.isGuest) {
    const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const rateLimitKey = forwardedFor || anonymousSessionId || userId;
    const rateLimit = await checkRateLimit(`unified-session:${rateLimitKey}`, 60, 60_000);
    if (!rateLimit.ok) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(rateLimit.retryAfterMs / 1000)) },
        },
      );
    }
  }

  // Ensure warmup + commitment fetch complete before DB-heavy work
  const [, commitmentLevel] = await Promise.all([warmupPromise, commitmentPromise]);

  // Module filter only counts as a "filter" (blocking fast paths) when it
  // genuinely narrows the requested rotation. Stale modules from another
  // rotation and whole-rotation selections such as "cah" are no-ops.
  const effectiveModulesFilter = normalizeModulesFilter(rotation, modulesFilter);
  // Guests: ignore feedMode — they have no progress to filter on, and forcing
  // the manifold path would degrade their fast-path experience.
  const feedMode = authResult.isGuest ? undefined : rawFeedMode;

  // feedMode=new-only wins over mode=crunch|rereview. Clear mode so the
  // manifold scheduler doesn't receive a hint that biases toward seen items.
  const effectiveMode = feedMode === 'new-only'
    || reviewFilter === 'due'
    || reviewFilter === 'at-risk'
    ? undefined
    : mode;

  const hasFilters = !!(
    typeFilter
    || difficultyFilter
    || topicsFilter
    || effectiveModulesFilter
    || effectiveMode
    || feedMode
    || reviewFilter
  );
  const noCache = searchParams.get('nocache') === '1';

  // Copyright image tier — gates image-as-prompt cards (S1). A standard/guest
  // user must never be served a card whose copyright image they can't see.
  // Defensive: any lookup failure defaults to the safe 'standard' tier rather
  // than crashing the session.
  let imageTier: 'standard' | 'copyright' = 'standard';
  if (!authResult.isGuest) {
    try {
      const tierRow = await prisma.user.findUnique({ where: { id: userId }, select: { imageTier: true } });
      if (tierRow?.imageTier === 'copyright') imageTier = 'copyright';
    } catch {
      // default 'standard'
    }
  }

  const ctx: SessionContext = {
    rotation,
    batchSize,
    weekFilter,
    sessionId,
    batchId,
    typeFilter,
    difficultyFilter,
    topicsFilter,
    modulesFilter: effectiveModulesFilter,
    mode: effectiveMode,
    reviewFilter,
    feedMode,
    clientExcludeCards,
    clientExcludeQuestions,
    clientExcludeCardSet,
    clientExcludeQuestionSet,
    hasClientExclusions,
    hasFilters,
    noCache,
    rotationContent,
    userId,
    isGuest: authResult.isGuest,
    imageTier,
    anonymousSessionId,
    t0,
    tAuthEnd,
    commitmentLevel,
  };

  if (feedMode === 'new-only') {
    const response = await withContractCheck('manifold', await buildManifoldSession(ctx));
    return protectPersonalRotationResponse(
      await withPrivateVideoDelivery(response, commitmentLevel),
      rotation,
    );
  }

  const filteredResponse = await withContractCheck(
    'review-filter',
    await tryReviewFilterSession(ctx),
  );
  if (filteredResponse) {
    return protectPersonalRotationResponse(
      await withPrivateVideoDelivery(filteredResponse, commitmentLevel),
      rotation,
    );
  }

  // Wrap each lane's result at the one place every lane returns through. The
  // manifold lane is non-nullable (the guaranteed terminal fallback), so its
  // overload resolves to `Promise<NextResponse>` and the whole chain is
  // NextResponse — no non-null assertion needed.
  const response = await withContractCheck('rereview', await tryRereviewSession(ctx))
    ?? await withContractCheck('starter', await tryStarterSession(ctx))
    ?? await withContractCheck('cache', await tryCachedSession(ctx))
    ?? await withContractCheck('instant', await tryInstantSession(ctx))
    ?? await withContractCheck('manifold', await buildManifoldSession(ctx));
  return protectPersonalRotationResponse(
    await withPrivateVideoDelivery(response, commitmentLevel),
    rotation,
  );
}

// Re-exports for backwards compatibility and testing
export type { UnifiedItem, InstantQuestionCandidate, SessionContext } from './unified-session-types';
export { parseBatchSize, compactMetadata, interleaveGroups, isPreferredInstantQuestion, selectInstantQuestionCandidates } from './unified-session-helpers';
export { itemMatchesModules } from '@/lib/modules/matching';
