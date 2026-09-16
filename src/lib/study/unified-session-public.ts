import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { parseCohortFeedProfile } from '@/lib/cohort/feed-profile';
import { mapStep1ItemToUnified } from '@/lib/cohort/public-review-map';
import { publicSessionPlan } from '@/lib/cohort/public-session-plan';
import { USMLE_STEP1_OPEN_ROTATION } from '@/lib/usmle/raw-question-boundary';
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
          cards: 0,
          questions: items.length,
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
