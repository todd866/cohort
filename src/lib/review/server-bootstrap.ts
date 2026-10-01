import 'server-only';

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { Institution } from '@/lib/institution';
import { SCHEDULED_ROTATIONS } from '@/lib/institution-rotations';
import {
  getActiveRotations,
  type TrackNumber,
} from '@/lib/rotation-context';
import { viewerCanAccessPersonalRotation } from '@/lib/personal-rotation-access';
import { inPlayStudyRotations } from '@/lib/study/in-play-rotations';
import { getUnifiedSession } from '@/lib/study/unified-session-service';
import { computeFetchSlots } from './compute-fetch-slots';
import { defaultPrimaryForViewer, resolvePrimaries } from './resolve-primaries';
import { parseReviewIntent, type ReviewFilter } from './review-intent';
import { resolveClusterLabel } from '@/lib/knowledge/cluster-subject-label';
import { buildUnifiedSessionParams } from '@/components/review/hooks/unified-session-params';
import {
  reviewLocationKey,
  reviewSessionScopeKey,
} from './session-scope';
import type { ReviewFeedMode } from './feed-mode';
import type {
  FetchSlot,
  InitialReviewBatch,
} from '@/components/review/hooks/useReviewSession';
import type { ReviewItem } from '@/components/review/hooks/types';
import type { ReviewServerBootstrap } from './bootstrap-types';
import { authorizedReviewTopicRotations } from './review-topic-registry.server';

const INSTITUTIONS = new Set<Institution>([
  'usyd',
  'usyd-md1',
  'usyd-md2',
  'usmle',
  'other',
]);

function interleave<T>(arrays: T[][]): T[] {
  const result: T[] = [];
  const maxLength = Math.max(0, ...arrays.map((array) => array.length));
  for (let index = 0; index < maxLength; index++) {
    for (const array of arrays) {
      if (index < array.length) result.push(array[index]);
    }
  }
  return result;
}

interface SessionPayload {
  items?: ReviewItem[];
  sessionId?: string | null;
  batchId?: string | null;
  newRemaining?: { cards: number; questions: number } | null;
}

/**
 * Build the first authenticated batch inside the page request.
 *
 * This function is called only after policy has ruled out route prefetches and
 * proved the feed mode through either a typed filter or the synced cookie.
 * Every successful slot response is included in the returned payload, so a
 * delivery write can never be discarded merely because another slot failed.
 */
export async function buildReviewServerBootstrap(args: {
  userId: string;
  searchParams: URLSearchParams;
  feedMode: ReviewFeedMode;
  /**
   * Validated IANA study-day timezone from the browser cookie. Threaded onto
   * the session request as `tz` so the server render computes the SAME
   * objective-core gate the browser's own fetch would; without it the gate
   * silently degrades to null and a streamed batch could disagree with the
   * lane the client expects.
   */
  studyTimezone?: string | null;
  /** Exact first-party hostname override resolved by the page request. */
  institutionOverride?: Institution | null;
  /** Canonical product origin resolved by the page host. */
  requestOrigin?: 'https://cohort.md' | 'https://md3.info';
}): Promise<ReviewServerBootstrap | null> {
  // Cohort uses only the idempotent browser-journey POST turn path. Keep this
  // defense even though the page bootstrap already short-circuits Cohort: a
  // future direct caller must not reintroduce an unadoptable legacy delivery.
  if (args.requestOrigin === 'https://cohort.md') return null;

  const user = await prisma.user.findUnique({
    where: { id: args.userId },
    select: {
      email: true,
      institution: true,
      track: true,
      activeModules: true,
      imageTier: true,
    },
  });
  if (!user) return null;

  const persistedInstitution = INSTITUTIONS.has(user.institution as Institution)
    ? user.institution as Institution
    : 'usyd';
  // cohort.md is a USMLE product surface even when the same authenticated
  // account last used md3.info. Resolve that boundary before the first serving
  // query so hydration can never replace a wrong-institution batch after it
  // has already been exposed.
  const institution = args.institutionOverride ?? persistedInstitution;
  const track = Number.isInteger(user.track) && user.track! >= 1 && user.track! <= 4
    ? user.track as TrackNumber
    : null;
  const activeModules = user.activeModules.filter((rotation) =>
    viewerCanAccessPersonalRotation(rotation, {
      emails: [user.email],
      imageTier: user.imageTier ?? null,
    })
  );
  const activeRotations = track ? getActiveRotations(track) : [];
  const scheduledRotations = SCHEDULED_ROTATIONS[institution];
  const studyable = inPlayStudyRotations(activeModules);
  // Cohort returned before any data read above, so only md3's private server
  // path reaches this point.
  const reviewTopicRotations = authorizedReviewTopicRotations(activeModules);
  // A cluster deep link is checked against LIVE cards in the named rotation,
  // not against the cluster's shape. Clusters are cross-rotation, and the one
  // that surfaced this (2026-09-15) held 359 live cards in six other rotations
  // and two soft-deleted ones in CAH — so `rotation=cah&cluster=<it>` named a
  // scope the rotation could not satisfy, and the session silently widened.
  // One indexed lookup, only when a cluster is actually in the URL; the first
  // parse is pure and only establishes which rotation to check against.
  const draft = parseReviewIntent(args.searchParams, studyable, reviewTopicRotations);
  const clusterParam = args.searchParams.get('cluster');
  // One count instead of a findFirst: it answers the same "are there live
  // cards here" question AND gives the banner its size, which is the part that
  // distinguishes two squares sharing a label. Indexed on (clusterId, rotation)
  // and only run when a cluster is actually in the URL, so the unscoped path
  // pays nothing.
  const clusterCardCount = clusterParam && draft.rotation && draft.cluster
    ? await prisma.card.count({
      where: { clusterId: clusterParam, rotation: draft.rotation, deletedAt: null },
    })
    : 0;
  const reviewClusterRotations = clusterParam && draft.rotation && draft.cluster
    ? { [clusterParam]: clusterCardCount > 0 ? [draft.rotation] : [] }
    : {};
  // The label is presentation only and the review surface has no other way to
  // learn it: the URL carries an opaque cluster id. Read it here, next to the
  // check that already had to happen, rather than adding a request-path lookup
  // later. A cluster with no row still scopes correctly; it just shows the
  // fallback name.
  const reviewClusterScope = clusterParam && draft.rotation && clusterCardCount > 0
    ? {
      id: clusterParam,
      label: resolveClusterLabel({
        clusterId: clusterParam,
        storedName: (await prisma.cluster.findUnique({
          where: { id: clusterParam },
          select: { name: true },
        }))?.name ?? '',
        rotation: draft.rotation,
        memberTopics: (await prisma.card.findMany({
          where: { clusterId: clusterParam, rotation: draft.rotation, deletedAt: null },
          select: { topics: true },
        })).map((card) => card.topics),
      }),
      cardCount: clusterCardCount,
      rotation: draft.rotation,
    }
    : null;
  const intent = parseReviewIntent(
    args.searchParams,
    studyable,
    reviewTopicRotations,
    reviewClusterRotations,
  );
  // A private topic deep link that is no longer authorized must not silently
  // widen into ordinary rotation review. Let the client render its neutral
  // unavailable state without creating a delivery. Same rule for a cluster the
  // rotation has no live cards in.
  if (args.searchParams.has('topics') && !intent.topics) return null;
  if (args.searchParams.has('cluster') && !intent.cluster) return null;
  const primaries = resolvePrimaries({
    activeModules,
    activeRotations,
    scheduledRotations,
  });
  // No enrolment signal: prefetch the onboarding default the client falls
  // through to when the chooser is skipped, so the batch stays adoptable.
  const primary = defaultPrimaryForViewer({
    primaries,
    enrolledStudyable: studyable,
    scheduledRotations,
  });
  if (!primary) return null;

  const feedMode: ReviewFeedMode = intent.filter === 'new'
    ? 'new-only'
    : intent.filter
      ? 'mixed'
      : args.feedMode;
  // Policy calls this builder only for progress-independent lanes (typed
  // filters or new-only). Mixed review remains client-gated until the server
  // owns a proven study-day timezone.
  const reviewed = 0;
  const focusRotation = intent.rotation ?? null;
  const fetchSlots = focusRotation
    ? computeFetchSlots({
        primary: focusRotation,
        focus: true,
        allRotations: scheduledRotations,
        track,
        todayReviewed: reviewed,
        feedMode,
      })
    : computeFetchSlots({
        primary,
        allRotations: scheduledRotations,
        track,
        todayReviewed: reviewed,
        feedMode,
      });
  const rotations = focusRotation
    ? [focusRotation]
    : (primaries.length > 0 ? primaries : [primary]);

  const settled = await Promise.allSettled(fetchSlots.map(async (slot: FetchSlot) => {
    const params = buildUnifiedSessionParams(slot, {
      week: intent.week,
      activeModules,
      feedMode,
      reviewFilter: intent.filter,
      itemType: intent.itemType,
      focusRotation,
      topics: intent.topics,
      timezone: args.studyTimezone ?? undefined,
    });
    const response = await getUnifiedSession(
      new NextRequest(`${args.requestOrigin ?? 'https://md3.info'}/api/study/unified-session?${params}`),
      { userId: args.userId, isGuest: false },
    );
    if (!response.ok) {
      throw new Error(`server review slot failed (${response.status})`);
    }
    const payload = await response.json() as SessionPayload;
    return { slot, payload };
  }));

  const delivered = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  );
  if (delivered.length === 0) return null;

  const perSlotItems = delivered.map(({ slot, payload }) =>
    (payload.items ?? []).map((item) => ({
      ...item,
      blendTier: slot.blendTier,
      sessionId: item.sessionId ?? payload.sessionId ?? null,
      batchId: item.batchId !== undefined ? item.batchId : payload.batchId ?? null,
    }))
  );
  const newRemaining = delivered.reduce<{ cards: number; questions: number } | null>(
    (total, { payload }) => {
      if (!payload.newRemaining) return total;
      if (!total) return { ...payload.newRemaining };
      return {
        cards: total.cards + payload.newRemaining.cards,
        questions: total.questions + payload.newRemaining.questions,
      };
    },
    null,
  );

  const initialBatch: InitialReviewBatch = {
    ownerKey: args.userId,
    scopeKey: reviewSessionScopeKey({
      rotations,
      week: intent.week,
      feedMode,
      reviewFilter: intent.filter as ReviewFilter | undefined,
      itemType: intent.itemType,
      focusRotation,
      topics: intent.topics,
    }),
    items: interleave(perSlotItems),
    newRemaining,
  };

  return {
    locationKey: reviewLocationKey(args.searchParams),
    institution,
    track,
    activeRotations,
    activeModules,
    reviewTopicRotations,
    reviewClusterRotations,
    reviewClusterScope,
    reviewed,
    feedMode,
    initialBatch,
  };
}
