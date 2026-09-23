import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { parseCohortFeedProfile } from '@/lib/cohort/feed-profile';
import { mapStep1ItemToUnified } from '@/lib/cohort/public-review-map';
import { publicSessionPlan } from '@/lib/cohort/public-session-plan';
import { USMLE_STEP1_OPEN_ROTATION } from '@/lib/usmle/raw-question-boundary';
import { findManyCards, ownerPrivateOrSharedCardScope } from '@/lib/cards/read-repository.server';
import {
  COPYRIGHT_STEP1_CARD_WHERE,
  loadCopyrightStep1Supplement,
} from '@/lib/study/copyright-step1-supplement';
import {
  createStep1Session,
  Step1ApiError,
} from '@/lib/usmle/step1-session.server';
import { logSessionDiagnostic } from './unified-session-diagnostics';
import type { SessionContext } from './unified-session-types';

export async function tryPublicCorpusSession(
  ctx: SessionContext,
): Promise<NextResponse | null> {
  if (ctx.rotation !== USMLE_STEP1_OPEN_ROTATION) return null;

  const row = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { feedProfile: true },
  });
  const profile = parseCohortFeedProfile(row?.feedProfile);
  const isCohort = ctx.publicSurface === 'cohort';
  if (isCohort && profile.hookCompletedAt && !profile.explicit.experience) {
    // The experience prior is a server-side serving precondition, not a UI
    // convention. Refuse to mint a delivery that the client must hide behind
    // onboarding; otherwise issued/exposure telemetry becomes false before the
    // causal turn contract even has a chance to replace this GET.
    return NextResponse.json(
      {
        error: 'Choose a study level before the next question',
        code: 'cohort_experience_required',
      },
      { status: 409 },
    );
  }
  const plan = isCohort ? publicSessionPlan(profile) : null;

  try {
    const result = await createStep1Session({
      userId: ctx.userId,
      mode: 'daily',
      size: plan?.turnSize ?? ctx.batchSize,
      prependQuestionIds: plan?.prependQuestionIds ?? [],
      allowedDifficulties: plan?.allowedDifficulties,
      surface: isCohort ? 'cohort' : 'usmle-step1',
      preferAdaptiveUnseen: isCohort,
      adaptiveCandidatePreference: plan?.adaptiveCandidatePreference,
    });
    const items = result.items.map((item, index) =>
      mapStep1ItemToUnified(item, {
        rotation: ctx.rotation,
        sessionId: result.sessionId,
        hook: index < result.hookItemCount,
      }),
    );
    const supplement = await loadCopyrightStep1Supplement({
      imageTier: ctx.imageTier,
      publicSurface: ctx.publicSurface,
      excludeCardIds: ctx.clientExcludeCardSet,
      seed: ctx.userId,
      load: () => loadPrivateStep1Store(ctx.userId),
    }).catch(() => []);
    items.push(...supplement);

    logSessionDiagnostic(ctx, {
      path: 'public',
      itemCount: items.length,
      totalMs: +(performance.now() - ctx.t0).toFixed(1),
    });

    return NextResponse.json({
      items,
      stats: {
        totalItems: items.length,
        version: 'public-step1',
        composition: {
          cards: items.filter((item) => item.type === 'card').length,
          questions: items.filter((item) => item.type === 'question').length,
          groups: 0,
          snippets: 0,
        },
      },
      availableFilters: { types: [], difficulties: [], topics: [] },
      sessionId: result.sessionId,
      batchId: result.sessionId,
    });
  } catch (error) {
    if (error instanceof Step1ApiError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    throw error;
  }
}

async function loadPrivateStep1Store(userId: string) {
  const [cards, questions] = await Promise.all([
    findManyCards(ownerPrivateOrSharedCardScope(userId), {
      where: COPYRIGHT_STEP1_CARD_WHERE,
      select: {
        id: true,
        front: true,
        back: true,
        context: true,
        topics: true,
      },
      orderBy: { id: 'asc' },
      take: 24,
    }),
    prisma.question.findMany({
      where: { rotation: 'usmle-step1' },
      select: {
        id: true,
        stem: true,
        context: true,
        difficulty: true,
        topics: true,
        options: true,
      },
      orderBy: { id: 'asc' },
      take: 12,
    }),
  ]);
  return { cards, questions };
}
