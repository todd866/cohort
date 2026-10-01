import { constructUnifiedSession } from '@/lib/knowledge/unified-scheduler';
import {
  CLIENT_REVIEW_BATCH_SIZE,
  type UnifiedItem,
  type SessionContext,
} from './unified-session-types';
import type { CommitmentLevel } from '@/lib/commitment';
import {
  hydrateScheduledItems,
  loadScheduledItemHydrationData,
} from './unified-session-hydration';
import { writeCacheBuildServeDecisions } from './serve-decision-write';
import { loadTeachingPaceForUser } from './teaching-pace-context';
import { fetchRecentFigureExposures } from '@/lib/knowledge/figure-exposure.server';
import { loadRecentQuestionFailures } from '@/lib/knowledge/recent-question-failures.server';
import { COURSE_TIME_ZONE } from '@/lib/rotation-context';
import { getStudyDayStart } from '@/lib/study-day';
import { computeRotationDailyTarget } from './rotation-daily-target';
import {
  noveltyProgressFromDailyTarget,
  queueNoveltyBudget,
  type NoveltyProgressSnapshot,
} from './novelty-budget';

/**
 * Opting a build into first-sight seats. `progress` is today's snapshot when
 * the caller already has it (a request-triggered refresh); otherwise it is read
 * here, off the request path, on the learner's study day.
 */
export interface CacheBuildNoveltyOptions {
  progress?: NoveltyProgressSnapshot | null;
  studyTimezone?: string | null;
}

async function resolveNoveltyProgress(
  userId: string,
  rotation: string,
  novelty: CacheBuildNoveltyOptions,
): Promise<NoveltyProgressSnapshot | null> {
  if (novelty.progress) return novelty.progress;
  const now = new Date();
  // A cron build has no request to take a timezone from. The course day is
  // Sydney's, and while unseen supply remains the reservation does not depend
  // on the day boundary at all.
  const startOfDay = getStudyDayStart(now, novelty.studyTimezone ?? COURSE_TIME_ZONE);
  try {
    return noveltyProgressFromDailyTarget(
      await computeRotationDailyTarget(userId, rotation, startOfDay, now),
    );
  } catch {
    // Degrade, never fail the build: a queue without the reservation is still
    // a queue, and the zero stamp below lets the next request with progress
    // trigger exactly one rebuild that carries it.
    return null;
  }
}

/**
 * Full manifold pipeline for background cache refresh.
 * Calls constructUnifiedSession WITHOUT exclusion data (scheduler fetches internally),
 * then hydrates from static content map + fallback DB queries.
 *
 * IMPORTANT — signed URL safety:
 * R2 signed URLs have a 2h TTL (hour-aligned). We must NOT store them in the
 * cache because a stale-cache hit after the hour boundary returns dead URLs.
 * Strategy: hydrate with session so trust-gating is correct, but strip the
 * short-lived `imageUrl` before storing. The stable `imageKey` and client-safe
 * `imageMeta` remain cached: metadata contains no delivery credential and is
 * required to preserve whether a figure is a prompt or after-reveal context.
 * At API egress (`tryCachedSession`) each item's `imageKey` is re-resolved to a
 * fresh signed URL for the current request.
 */
export async function computeAndHydrateSession(
  userId: string,
  rotation: string,
  weekFilter: number | null,
  batchSize: number,
  rotationContent: SessionContext['rotationContent'],
  imageTier: SessionContext['imageTier'],
  commitmentLevel?: CommitmentLevel,
  cacheBuildSessionId?: string,
  options: {
    includeFailureAttribution?: boolean;
    /** Reserve first-sight seats the way the live build does. */
    novelty?: CacheBuildNoveltyOptions;
  } = {},
): Promise<{ items: UnifiedItem[] }> {
  // Cache-built sessions are the majority of what gets delivered, so they must
  // be paced against the course calendar exactly as the live path is. Resolved
  // from the user's track here because this path has no request context.
  const [
    { currentTeachingWeek, topicTeachingWeeks },
    recentFigureExposures,
    recentQuestionFailures,
    noveltyProgress,
  ] = await Promise.all([
    loadTeachingPaceForUser(userId, rotation),
    // ~550ms, so it lives here rather than on the request path.
    fetchRecentFigureExposures(userId),
    // Replaces the scheduler's third failure read. A database timeout/error
    // leaves the original compatibility read available; live callers never
    // import this history join.
    options.includeFailureAttribution
      ? loadRecentQuestionFailures(userId, rotation, weekFilter).catch(() => undefined)
      : Promise.resolve(undefined),
    options.novelty
      ? resolveNoveltyProgress(userId, rotation, options.novelty)
      : Promise.resolve(null),
  ]);
  // The live build reserves first sights from today's progress. Without the
  // same reservation here, the queue most learners are served spends the day
  // on repeats while the rotation still has unseen cards.
  const noveltyBudget = noveltyProgress
    ? queueNoveltyBudget({
        queueSize: batchSize,
        servedBatchSize: CLIENT_REVIEW_BATCH_SIZE,
        progress: noveltyProgress,
      })
    : null;

  const sessionResult = await constructUnifiedSession(userId, {
    rotation,
    week: weekFilter ?? undefined,
    size: batchSize,
    commitmentLevel: commitmentLevel ?? 'browser',
    imageTier,
    currentTeachingWeek,
    topicTeachingWeeks,
    recentFigureExposures,
    ...(recentQuestionFailures ? { recentQuestionFailures } : {}),
    ...(noveltyBudget ? { minFirstSightItems: noveltyBudget.minFirstSightItems } : {}),
  });

  if (sessionResult.items.length === 0) return { items: [] };

  const hydrationData = await loadScheduledItemHydrationData({
    userId,
    rotationContent,
    scheduledItems: sessionResult.items,
    deliveryContext: { userId, rotation, weekFilter, practiceLocale: 'au', crossSourceRotations: [] },
  });

  // Background cache refresh always runs for real (non-guest) users.
  // Construct a minimal synthetic session so resolveImage can gate
  // auth-required images correctly (trust check still runs; signing is free
  // but its result is stripped before storage — see note above).
  const session = {
    user: { id: userId, imageTier },
  } as import('next-auth').Session;

  const hydratedItems = await hydrateScheduledItems(sessionResult.items, hydrationData, {
    rotation,
    // Videos are OFF, and this is deliberate — do not flip it back without
    // reading this.
    //
    // `Video` / `/api/videos/[id]/delivery` / `VideoItemView` are the
    // Instagram-style reel feed, which is parked. The endpoint that component
    // fetches on mount is wrapped in `quarantineLegacyApi`, which calls
    // `requireAdmin()` before the handler runs — so any video item reaching a
    // non-admin learner renders a component that 403s immediately. This was the
    // only production caller passing `includeVideos: true`, which made it the
    // one place the reel stack was armed.
    //
    // Nothing was firing (0 video ServeDecisions in 30d) only because the 1,562
    // published videos were never embedded, so they never became candidates.
    // That is a content decision, not a guard: embedding them would have broken
    // the feed for every learner except the admin.
    //
    // Surgery video-flashcards are a SEPARATE stack — `VideoSource` +
    // `VideoClip`, rendered as cloze/MCQ stems through `CardItemView` — and
    // deliberately do not reuse the `Video` model, which is reel-shaped with an
    // Instagram permission lifecycle. Clip prompts are unaffected by this flag.
    //
    // The reel feed is dormant, not dead: the code, schema, R2 objects and
    // embeddings stay. If it is revived, fix the delivery path properly first —
    // `withPrivateVideoDelivery` already mints a rights-checked signed
    // `videoUrl` onto the item that `VideoItemView` currently ignores in favour
    // of the admin-only route.
    includeVideos: false,
  }, session);

  // Strip signed URLs before caching. Keep the stable imageKey and client-safe
  // metadata so non-egress consumers (notably the offline pack) retain figure
  // placement. resolveImage is called again at live API egress for a fresh URL.
  //
  // A build that opted into first-sight seats stamps every item with the
  // reservation it was made under (zero when progress was unreadable). The
  // cache lane reads the stamp to tell a queue that predates the reservation,
  // which it rebuilds once, from one that honestly ran short of unseen supply,
  // which it must not rebuild in a loop.
  const noveltyStamp = options.novelty
    ? {
        noveltyQuotaRequired: noveltyBudget?.minFirstSightItems ?? 0,
        noveltyQuotaSelected: sessionResult.noveltyQuota?.selected
          ?? hydratedItems.filter((item) => item.firstSightAtSelection).length,
      }
    : {};
  const itemsForCache: UnifiedItem[] = hydratedItems.map((item) => ({
    ...item,
    ...noveltyStamp,
    imageUrl: null,
  }));

  if (cacheBuildSessionId) {
    const itemsWithDecisions = await writeCacheBuildServeDecisions(itemsForCache, {
      userId,
      cacheBuildSessionId,
      rotation,
      decisionPath: 'cache-refresh',
      queueReason: 'precompute',
    });
    return { items: itemsWithDecisions };
  }

  return { items: itemsForCache };
}
