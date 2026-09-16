import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrGuest } from '@/lib/api-utils';
import { auth as authFn } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  getActiveRotations,
  getBlockExamDate,
  getBlockStartDate,
  type TrackNumber,
} from '@/lib/rotation-context';
import { resolveTeachingPace } from './teaching-pace-context';
import { isCohortHostname } from '@/lib/institution';
import { logger } from '@/lib/logger';
import { resolveServeRequestId } from './serve-request-id';
import { checkRateLimit } from '@/lib/rate-limit';
import { getRotationContent } from '@/lib/study/rotation-content-map';
import { getCommitmentProfile } from '@/lib/commitment';
import type { CommitmentLevel } from '@/lib/commitment';
import type { SessionContext, UnifiedItem } from './unified-session-types';
import { checkServedItemContract } from './served-item-contract';
import { parseBatchSize } from './unified-session-helpers';
import { ROTATION_TO_MODULES } from './unified-session-manifold-items';
import { itemMatchesModules } from '@/lib/modules/matching';
import { tryPublicCorpusSession } from './unified-session-public';
import { tryStarterSession } from './unified-session-starter';
import { tryRereviewSession } from './unified-session-rereview';
import { tryReviewFilterSession } from './unified-session-review-filter';
import { tryCachedSession } from './unified-session-cache';
import { tryInstantSession } from './unified-session-instant';
import { buildManifoldSession } from './unified-session-manifold';
import { withPrivateVideoDelivery } from './private-video-delivery';
import { resolvePracticeLocale } from './practice-locale';
import { PERSONAL_ROTATION_IDS } from '@/lib/rotations';
import { viewerCanAccessRequestedRotations } from '@/lib/personal-rotation-access';
import {
  REVIEW_FILTERS,
  type ReviewFilter,
} from '@/lib/review/review-intent';
import { registeredReviewTopicRotation } from '@/lib/review/review-topic-registry.server';
import { USMLE_STEP1_OPEN_ROTATION, USMLE_STEP1_PRIMARY_ROTATION } from '@/lib/usmle/raw-question-boundary';
import { isSupplementaryRotation } from '@/lib/supplementary-rotations';
import { entitledExamCrossSourceRotations } from './cross-source-access.server';
import { resolvePrimaries } from '@/lib/review/resolve-primaries';
import {
  REACHABLE_ROTATIONS,
  SCHEDULED_ROTATIONS,
} from '@/lib/institution-rotations';
import {
  loadRuntimeExamTarget,
  type ExamTargetRepositoryClient,
} from '@/lib/exam-target/repository.server';
import {
  YEAR3_EXAM_TARGET_ROTATIONS,
  type ExamTargetRotation,
} from '@/lib/exam-target/types';
import {
  resolveExamTargetLanePolicy,
  type ExamTargetServingLane,
} from '@/lib/exam-target/lane-policy';
import {
  admitExamTargetDecisionAttempt,
  type ExamTargetAttemptDecisionPath,
  type ExamTargetAttemptLedgerClient,
} from '@/lib/exam-target/attempt-ledger.server';
import { getStudyDayStart } from '@/lib/study-day';
import { evaluateObjectiveCoreGate } from './objective-core-gate';
import { effectiveExamDailyTarget } from './effective-daily-target';
import { computeRotationDailyTarget } from './rotation-daily-target';
import { isComposedDeck } from '@/lib/personal-decks';
import {
  dessertCrossSourceSlots,
  dessertOtherSourceShare,
  dessertOvershootRatio,
  dessertUnmappedSlots,
} from './dessert-mix';

const PERSONAL_ROTATIONS = new Set<string>(PERSONAL_ROTATION_IDS);
const REVIEW_FILTER_SET = new Set<string>(REVIEW_FILTERS);
const YEAR3_EXAM_TARGET_ROTATION_SET = new Set<string>(YEAR3_EXAM_TARGET_ROTATIONS);

function validatedStudyTimezone(value: string | null): string | null {
  if (!value || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return value;
  } catch {
    return null;
  }
}

function examTargetHardOff(): boolean {
  const value = process.env.EXAM_TARGET_V2_HARD_OFF?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

function targetCapableDecisionPath(input: {
  isGuest: boolean;
  typeFilter: 'card' | 'question' | 'group' | null;
  reviewFilter: ReviewFilter | undefined;
  requestedMode: 'crunch' | 'rereview' | undefined;
}): ExamTargetAttemptDecisionPath | null {
  // Guest blueprint-only targeting remains disabled until it has a concrete,
  // privacy-reviewed runtime and telemetry path. Questions/groups and the
  // duplicate rereview slot likewise have no target-capable writer today.
  if (input.isGuest
    || input.typeFilter === 'question'
    || input.typeFilter === 'group'
    || input.requestedMode === 'rereview'
      && (input.reviewFilter === 'due' || input.reviewFilter === 'at-risk')) {
    return null;
  }
  return input.reviewFilter === 'due' || input.reviewFilter === 'at-risk'
    ? 'review-filter'
    : 'manifold-walk';
}

function mayServeExamTargetLane(
  ctx: SessionContext,
  lane: ExamTargetServingLane,
): boolean {
  return resolveExamTargetLanePolicy({
    effectiveMode: ctx.examTarget?.resolved.effectiveMode ?? 'off',
    assignment: ctx.examTarget?.resolved.assignment ?? 'control',
    lane,
    targetRotation: ctx.rotation,
    targetVersion: ctx.examTarget?.resolved.targetVersion ?? null,
    // Each lane remains false until its own paired replay and provenance gates
    // pass. An activation pointer cannot turn on code a lane cannot execute.
    parity: false,
  }).mayServe;
}

function protectPersonalRotationResponse(
  response: NextResponse,
  rotations: readonly string[],
): NextResponse {
  if (rotations.some((rotation) =>
    PERSONAL_ROTATIONS.has(rotation) || isSupplementaryRotation(rotation)
  )) {
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
 * `manifold`; `new-only` tries `instant` then `manifold`, and mixed mode uses
 * `manifold` as the terminal fallback — still one lane). Enforcing the served-item contract
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
  const requestHost = (request.headers.get('host') ?? new URL(request.url).host)
    .split(':')[0]
    .toLowerCase();
  const rotation = searchParams.get('rotation');
  const sizeParam = searchParams.get('size');
  const weekParam = searchParams.get('week');
  const studyTimezone = validatedStudyTimezone(searchParams.get('tz'));
  const explicitFocus = searchParams.get('focus') === '1';
  // One logical fetch keeps one session id across its retries, so a retried
  // delivery updates the first one in place instead of minting a duplicate.
  const sessionId = resolveServeRequestId(searchParams.get('sid'));
  const batchId = randomUUID();

  // Filter params
  const typeFilter = searchParams.get('type') as 'card' | 'question' | 'group' | null;
  const difficultyFilter = searchParams.get('difficulty') as 'easy' | 'medium' | 'hard' | null;
  const topicsFilter = searchParams.get('topics'); // comma-separated
  // One manifold cluster, from a square on the profile knowledge heatmap.
  // Shape-validated here as well as in parseReviewIntent: this value reaches a
  // database filter, and the client is not the only caller of this route.
  const rawCluster = searchParams.get('cluster');
  const clusterFilter = rawCluster && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(rawCluster)
    ? rawCluster
    : null;
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
  // The canonical import partition is custody, not a product rotation. Until a
  // deck-scoped owner/active-epoch serving contract is deployed, arbitrary DB
  // rotation strings must never become a back door into private uploads.
  if (
    rotation === USMLE_STEP1_PRIMARY_ROTATION
    || !REACHABLE_ROTATIONS.has(rotation)
  ) {
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

  let authResult: { userId: string; isGuest: boolean };
  // Timed on its own (see SessionContext.tIdentityMs): this is the request's
  // first database touch, so a stalled Neon connection is paid here rather
  // than anywhere later in the auth span.
  const tIdentityStart = performance.now();
  if (authOverride) {
    authResult = authOverride;
  } else {
    const resolvedAuth = await requireAuthOrGuest(request);
    if (resolvedAuth.response) return resolvedAuth.response;
    authResult = resolvedAuth;
  }
  const tIdentityMs = +(performance.now() - tIdentityStart).toFixed(1);

  // Auth (including the intentional guest path) must resolve before even a
  // connection-pool warmup touches the database. The warmup still overlaps
  // the remaining authorization work and is awaited before DB-heavy serving.
  const warmupPromise = prisma.$queryRaw`SELECT 1`.catch(() => {});

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

  // One persisted authorization snapshot drives direct access, cross-source
  // eligibility, image tier, and teaching pace. Query parameters never grant
  // access to a content source.
  const userScope = authResult.isGuest
    ? null
    : await prisma.user.findUnique({
        where: { id: authResult.userId },
        select: {
          email: true,
          emailAliases: {
            where: { verified: true },
            select: { email: true, verified: true },
          },
          activeModules: true,
          imageTier: true,
          track: true,
          institution: true,
          studyGoal: true,
          rotations: {
            where: { rotation },
            select: { examDate: true },
            take: 1,
          },
        },
      }).catch(() => null);

  // Personal rotations are intentionally undiscoverable unless the signed-in
  // user's persisted module entitlements include the requested rotation. Keep
  // this server-side and fail closed so a forged route cannot bypass the UI.
  if (PERSONAL_ROTATIONS.has(rotation)) {
    if (authResult.isGuest) {
      return protectPersonalRotationResponse(
        NextResponse.json({ error: 'Rotation not found' }, { status: 404 }),
        [rotation],
      );
    }

    if (
      !userScope ||
      !viewerCanAccessRequestedRotations(
        [rotation],
        {
          emails: [
            userScope.email,
            ...(userScope.emailAliases ?? [])
              .filter((alias) => alias.verified)
              .map((alias) => alias.email),
          ],
          imageTier: userScope.imageTier ?? null,
        },
      ) ||
      !userScope.activeModules.includes(rotation)
    ) {
      return protectPersonalRotationResponse(
        NextResponse.json({ error: 'Rotation not found' }, { status: 404 }),
        [rotation],
      );
    }
  }

  // Supplementary partitions are authenticated opt-ins, never public exam
  // banks. Personal supplementary sources have already passed the stronger
  // immutable-owner check above.
  if (isSupplementaryRotation(rotation)) {
    if (authResult.isGuest || !userScope?.activeModules.includes(rotation)) {
      return protectPersonalRotationResponse(
        NextResponse.json({ error: 'Rotation not found' }, { status: 404 }),
        [rotation],
      );
    }
  }

  const identityEmails = userScope
    ? [
        userScope.email,
        ...(userScope.emailAliases ?? [])
          .filter((alias) => alias.verified)
          .map((alias) => alias.email),
      ]
    : [];
  // Bind canonical private topics at the API boundary, but only after the
  // viewer has proved entitlement to the owning rotation. Otherwise a guessed
  // slug would become a pre-auth registry oracle. Unentitled callers receive
  // the same ordinary generic-topic behavior as any unknown filter.
  const entitledMismatchedRegisteredTopic = topicsFilter
    ?.split(',')
    .map((topic) => topic.trim())
    .filter(Boolean)
    .find((topic) => {
      const registeredRotation = registeredReviewTopicRotation(topic);
      if (!registeredRotation || registeredRotation === rotation || !userScope) {
        return false;
      }
      return userScope.activeModules.includes(registeredRotation)
        && viewerCanAccessRequestedRotations(
          [registeredRotation],
          {
            emails: identityEmails,
            imageTier: userScope.imageTier ?? null,
          },
        );
    });
  if (entitledMismatchedRegisteredTopic) {
    return NextResponse.json(
      { items: [], sessionId, batchId },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  const currentObjective = userScope
    ? resolvePrimaries({
        activeModules: userScope.activeModules,
        activeRotations:
          Number.isInteger(userScope.track)
          && userScope.track! >= 1
          && userScope.track! <= 4
            ? getActiveRotations(userScope.track as TrackNumber)
            : [],
        scheduledRotations: SCHEDULED_ROTATIONS[
          userScope.institution as keyof typeof SCHEDULED_ROTATIONS
        ] ?? SCHEDULED_ROTATIONS.usyd,
      })[0] ?? null
    : null;
  const entitledCrossSourceRotations = entitledExamCrossSourceRotations({
    targetRotation: rotation,
    currentObjective,
    isGuest: authResult.isGuest,
    explicitFocus,
    activeModules: userScope?.activeModules ?? [],
    emails: identityEmails,
    imageTier: userScope?.imageTier === 'copyright' ? 'copyright' : 'standard',
  });
  let crossSourceRotations: string[] = [];
  let maxCrossSourceItems = 0;
  let crossSourceMappingMode: 'adjacent' | 'open' = 'adjacent';
  if (entitledCrossSourceRotations.length > 0) {
    const validTrack = Number.isInteger(userScope?.track)
      && userScope!.track! >= 1
      && userScope!.track! <= 4
      ? userScope!.track as TrackNumber
      : null;
    const startDate = validTrack ? getBlockStartDate(rotation, validTrack) : null;
    const examDate = userScope?.rotations?.[0]?.examDate
      ?? (validTrack ? getBlockExamDate(rotation, validTrack) : null);
    const gateNow = new Date();
    const studyDayStart = studyTimezone
      ? getStudyDayStart(gateNow, studyTimezone)
      : null;
    const nativeAnswersToday = studyTimezone && startDate && examDate && studyDayStart
      ? await prisma.learningEvent.count({
          where: {
            userId: authResult.userId,
            rotation,
            eventType: { in: ['card_reviewed', 'mcq_attempted'] },
            timestamp: { gte: studyDayStart },
          },
        }).catch(() => null)
      : null;
    const adaptiveTarget = studyDayStart
      ? await computeRotationDailyTarget(
        authResult.userId,
        rotation,
        studyDayStart,
        gateNow,
      ).then((row) => row.dailyTarget).catch(() => null)
      : null;
    const dailyTarget = effectiveExamDailyTarget({
      adaptive: adaptiveTarget,
      studyGoal: userScope?.studyGoal ?? null,
    });
    const coreGate = evaluateObjectiveCoreGate({
      now: gateNow,
      startDate,
      examDate,
      dailyTarget,
      nativeAnswersToday,
    });
    // A composed (blended) deck draws on its companions as one pool with its
    // own cards. NSx owned nothing until 2026-09-16 and the core gate — which
    // exists so a side deck cannot crowd out the exam a learner has actually
    // booked — withheld the ENTIRE deck, so it never built a session. It now
    // owns the Kubie corpus (1,875 cards) and still borrows ~2,900 plates and
    // BlueLink cards, so the blend is still the larger part of the meal.
    //
    // Focusing a composed deck is a deliberate act, so treat its companions as
    // the meal rather than the dessert. The blend into other rotations is
    // untouched: this widens only the session the learner explicitly asked for.
    if (isComposedDeck(rotation)) {
      maxCrossSourceItems = batchSize;
      crossSourceRotations = entitledCrossSourceRotations;
      crossSourceMappingMode = 'adjacent';
    } else if (
      coreGate.unlocked
      && reviewFilter !== 'due'
      && reviewFilter !== 'at-risk'
    ) {
      const overshoot = dessertOvershootRatio(
        coreGate.nativeAnswersToday ?? 0,
        coreGate.minimum,
      );
      const share = dessertOtherSourceShare(overshoot);
      maxCrossSourceItems = dessertCrossSourceSlots(batchSize, share);
      const unmapped = dessertUnmappedSlots(maxCrossSourceItems, overshoot);
      if (maxCrossSourceItems > 0) {
        crossSourceRotations = entitledCrossSourceRotations;
        crossSourceMappingMode = unmapped > 0 ? 'open' : 'adjacent';
      }
    }
    logger.info('objective-core-gate', {
      rotation,
      phase: coreGate.phase,
      minimum: coreGate.minimum,
      nativeAnswersToday: coreGate.nativeAnswersToday,
      unlocked: coreGate.unlocked,
      maxCrossSourceItems,
      crossSourceMappingMode,
    });
  }
  const privateResponseRotations = [rotation, ...crossSourceRotations];

  const userId = authResult.userId;
  const anonymousSessionId = authResult.isGuest ? userId : undefined;
  const tAuthEnd = performance.now();

  // Timed separately (see SessionContext.tContentMapMs): a fresh instance's
  // multi-MB content-map import used to be billed inside auth;dur.
  const rotationContent = await getRotationContent(rotation);
  const tContentMapMs = +(performance.now() - tAuthEnd).toFixed(1);

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
    || clusterFilter
    || effectiveModulesFilter
    || effectiveMode
    || feedMode
    || reviewFilter
    || crossSourceRotations.length > 0
  );
  const noCache = searchParams.get('nocache') === '1';

  // Copyright image tier — gates image-as-prompt cards (S1). A standard/guest
  // user must never be served a card whose copyright image they can't see.
  // Defensive: any lookup failure defaults to the safe 'standard' tier rather
  // than crashing the session.
  let imageTier: 'standard' | 'copyright' = 'standard';
  if (userScope?.imageTier === 'copyright') {
    imageTier = 'copyright';
  }

  // Curriculum pacing: the teaching week the student's course is currently in,
  // so material it has not reached yet sinks in the ranker. Derived server-side
  // from the authenticated user's track — never accepted from the client, which
  // would let a caller reorder its own queue by asserting a week. A missing
  // track, an unscheduled rotation, or a date before the block starts all yield
  // null, and null is inert.
  const { currentTeachingWeek, topicTeachingWeeks } = resolveTeachingPace(
    rotation,
    userScope?.track,
  );


  const targetDecisionPath = targetCapableDecisionPath({
    isGuest: authResult.isGuest,
    typeFilter,
    reviewFilter,
    requestedMode: mode,
  });
  const loadedExamTarget = targetDecisionPath !== null
    && YEAR3_EXAM_TARGET_ROTATION_SET.has(rotation)
    ? await loadRuntimeExamTarget({
        client: prisma as unknown as ExamTargetRepositoryClient,
        rotation: rotation as ExamTargetRotation,
        hardOff: examTargetHardOff(),
        assignmentKey: userId,
      })
    : undefined;
  let examTarget = loadedExamTarget;
  let examTargetAttempt: SessionContext['examTargetAttempt'];
  const targetIsUsable = Boolean(
    examTarget?.resolved.effectiveMode !== 'off'
    && examTarget?.snapshot
    && examTarget.activationRevision !== null
    && examTarget.schedulerVersion
    && examTarget.policyDigest,
  );
  if (targetIsUsable && targetDecisionPath !== null && examTarget?.snapshot) {
    try {
      const admitted = await admitExamTargetDecisionAttempt(
        prisma as unknown as ExamTargetAttemptLedgerClient,
        {
          userId,
          sessionId,
          batchId,
          rotation: examTarget.snapshot.rotation,
          decisionPath: targetDecisionPath,
          targetSnapshotId: examTarget.snapshot.id,
          activationRevision: examTarget.activationRevision!,
          schedulerVersion: examTarget.schedulerVersion!,
          policyDigest: examTarget.policyDigest!,
          mode: examTarget.resolved.effectiveMode as 'shadow' | 'active',
          assignment: examTarget.resolved.assignment,
          requestedSize: batchSize,
        },
      );
      examTargetAttempt = Object.freeze({
        id: admitted.id,
        decisionPath: targetDecisionPath,
      });
    } catch {
      logger.warn('exam-target-attempt-admission-failed', {
        code: 'admission-failed',
        rotation,
        decisionPath: targetDecisionPath,
      });
      examTarget = undefined;
    }
  } else if (targetIsUsable) {
    // A valid activation does not authorize a path without an admitted writer.
    examTarget = undefined;
  }

  const practiceLocale = resolvePracticeLocale({
    institution: userScope?.institution,
    requestRotation: rotation,
  });

  const ctx: SessionContext = {
    rotation,
    publicSurface: isCohortHostname(requestHost) ? 'cohort' : 'usmle-step1',
    examTarget,
    examTargetAttempt,
    batchSize,
    weekFilter,
    sessionId,
    batchId,
    typeFilter,
    difficultyFilter,
    topicsFilter,
    clusterFilter,
    modulesFilter: effectiveModulesFilter,
    requestedMode: mode,
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
    practiceLocale,
    anonymousSessionId,
    t0,
    tAuthEnd,
    tContentMapMs,
    tIdentityMs,
    commitmentLevel,
    currentTeachingWeek,
    topicTeachingWeeks,
    crossSourceRotations,
    maxCrossSourceItems,
    crossSourceMappingMode,
  };

  if (ctx.rotation === USMLE_STEP1_OPEN_ROTATION) {
    const publicResponse = await withContractCheck(
      'public',
      await tryPublicCorpusSession(ctx),
    );
    if (publicResponse) {
      return protectPersonalRotationResponse(
        await withPrivateVideoDelivery(publicResponse, commitmentLevel),
        privateResponseRotations,
      );
    }
    return NextResponse.json(
      { error: 'Public corpus unavailable' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }

  if (feedMode === 'new-only') {
    // New-only used to skip every fast lane and pay a 20–30s manifold build.
    // Instant is safe here because it applies the all-time seen exclusion.
    // Rereview/starter/cache stay off: they are mixed or seen-item lanes.
    const response = (
      mayServeExamTargetLane(ctx, 'instant')
        ? await withContractCheck('instant', await tryInstantSession(ctx))
        : null
    )
      ?? await withContractCheck('manifold', await buildManifoldSession(ctx));
    return protectPersonalRotationResponse(
      await withPrivateVideoDelivery(response, commitmentLevel),
      privateResponseRotations,
    );
  }

  const filteredResponse = await withContractCheck(
    'review-filter',
    await tryReviewFilterSession(ctx),
  );
  if (filteredResponse) {
    return protectPersonalRotationResponse(
      await withPrivateVideoDelivery(filteredResponse, commitmentLevel),
      privateResponseRotations,
    );
  }

  // Wrap each lane's result at the one place every lane returns through. The
  // manifold lane is non-nullable (the guaranteed terminal fallback), so its
  // overload resolves to `Promise<NextResponse>` and the whole chain is
  // NextResponse — no non-null assertion needed.
  const response = (
    mayServeExamTargetLane(ctx, 'rereview')
      ? await withContractCheck('rereview', await tryRereviewSession(ctx))
      : null
  )
    ?? (
      mayServeExamTargetLane(ctx, 'starter')
        ? await withContractCheck('starter', await tryStarterSession(ctx))
        : null
    )
    ?? (
      mayServeExamTargetLane(ctx, 'cache')
        ? await withContractCheck('cache', await tryCachedSession(ctx))
        : null
    )
    ?? (
      mayServeExamTargetLane(ctx, 'instant')
        ? await withContractCheck('instant', await tryInstantSession(ctx))
        : null
    )
    ?? await withContractCheck('manifold', await buildManifoldSession(ctx));
  return protectPersonalRotationResponse(
    await withPrivateVideoDelivery(response, commitmentLevel),
    privateResponseRotations,
  );
}

// Re-exports for backwards compatibility and testing
export type { UnifiedItem, InstantQuestionCandidate, SessionContext } from './unified-session-types';
export { parseBatchSize, compactMetadata, interleaveGroups, isPreferredInstantQuestion, selectInstantQuestionCandidates } from './unified-session-helpers';
export { itemMatchesModules } from '@/lib/modules/matching';
