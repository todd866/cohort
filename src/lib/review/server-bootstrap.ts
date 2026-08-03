import 'server-only';

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { Institution } from '@/lib/institution';
import { SCHEDULED_ROTATIONS } from '@/lib/institution-rotations';
import {
  getActiveRotations,
  type TrackNumber,
} from '@/lib/rotation-context';
import { emailCanAccessPersonalRotation } from '@/lib/personal-rotation-access';
import { inPlayStudyRotations } from '@/lib/study/in-play-rotations';
import { getUnifiedSession } from '@/lib/study/unified-session-service';
import { computeFetchSlots } from './compute-fetch-slots';
import { resolvePrimaries } from './resolve-primaries';
import { parseReviewIntent, type ReviewFilter } from './review-intent';
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
  /** Exact first-party hostname override resolved by the page request. */
  institutionOverride?: Institution | null;
}): Promise<ReviewServerBootstrap | null> {
  const user = await prisma.user.findUnique({
    where: { id: args.userId },
    select: {
      email: true,
      institution: true,
      track: true,
      activeModules: true,
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
    emailCanAccessPersonalRotation(rotation, user.email)
  );
  const activeRotations = track ? getActiveRotations(track) : [];
  const scheduledRotations = SCHEDULED_ROTATIONS[institution];
  const studyable = inPlayStudyRotations(activeModules);
  const intent = parseReviewIntent(args.searchParams, studyable);
  const primaries = resolvePrimaries({
    activeModules,
    activeRotations,
    scheduledRotations,
  });
  const primary = primaries[0] ?? scheduledRotations[0];
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
        primary: primaries.length > 1 ? primaries : primary,
        allRotations: scheduledRotations,
        track,
        todayReviewed: reviewed,
        feedMode,
      });
  const rotations = focusRotation ? [focusRotation] : primaries;

  const settled = await Promise.allSettled(fetchSlots.map(async (slot: FetchSlot) => {
    const params = buildUnifiedSessionParams(slot, {
      week: intent.week,
      activeModules,
      feedMode,
      reviewFilter: intent.filter,
      focusRotation,
    });
    const response = await getUnifiedSession(
      new NextRequest(`https://md3.info/api/study/unified-session?${params}`),
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
      sessionId: payload.sessionId ?? null,
      batchId: payload.batchId ?? null,
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
      focusRotation,
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
    reviewed,
    feedMode,
    initialBatch,
  };
}
