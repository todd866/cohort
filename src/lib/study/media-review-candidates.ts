import { publicClipWhere } from '@/lib/video/public-clips';
import { prisma } from '@/lib/prisma';
import { findManyCards, ownerPrivateOrSharedCardScope } from '@/lib/cards/read-repository.server';
import type { SessionContext } from './unified-session-types';
import { matchesCandidateImage } from './media-review';

/** Image membership is a local projection of the static rotation pool. Clips
 * use a small current rights query, never the whole rotation's card IDs.
 * Source policy, due/freshness gates and current-body resolution still run in
 * the caller before delivery. */
export async function loadInstantMediaCandidateIds(ctx: SessionContext) {
  if (!ctx.media) return null;
  const trust = ctx.imageTier === 'copyright'
    ? 'copyright-required'
    : ctx.isGuest ? 'public' : 'auth-required';
  const cards = new Set<string>();
  const questions = new Set<string>();
  if (ctx.media === 'image' || ctx.media === 'any') {
    for (const card of ctx.rotationContent.cardList) {
      if (matchesCandidateImage(card.imageUrl, trust)) cards.add(card.id);
    }
    for (const question of ctx.rotationContent.questionList) {
      if (matchesCandidateImage(question.imageUrl, trust)) questions.add(question.id);
    }
  }
  if (ctx.media === 'video' || ctx.media === 'any') {
    const clearedClips = await prisma.videoClip.findMany({
      where: ctx.imageTier === 'copyright' ? { deletedAt: null, source: { rightsStatus: 'cleared' } } : publicClipWhere(),
      select: { id: true },
    });
    const clipIds = clearedClips.map(clip => clip.id);
    if (clipIds.length > 0) {
      const [videoCards, videoQuestions] = await Promise.all([
        findManyCards(ownerPrivateOrSharedCardScope(ctx.userId), {
          where: { clipId: { in: clipIds }, rotation: ctx.rotation },
          select: { id: true },
        }),
        prisma.question.findMany({
          where: { clipId: { in: clipIds }, rotation: ctx.rotation },
          select: { id: true },
        }),
      ]);
      for (const card of videoCards) cards.add(card.id);
      for (const question of videoQuestions) questions.add(question.id);
    }
  }
  return {
    cards,
    questions,
  };
}
