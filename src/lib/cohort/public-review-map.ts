import type { Step1SessionItem } from '@/lib/usmle/step1-contract';
import type { UnifiedItem } from '@/lib/study/unified-session-types';
import type { CohortCardSessionItem } from './card-turn-contract';

export function mapStep1ItemToUnified(
  item: Step1SessionItem,
  args: { rotation: string; sessionId: string; hook?: boolean },
): UnifiedItem {
  const media = item.media;
  return {
    type: 'question',
    id: item.deliveryId,
    deliveryId: item.deliveryId,
    stem: item.stem,
    options: item.options.map((option) => ({
      label: option.label,
      text: option.text,
    })),
    rotation: args.rotation,
    week: null,
    difficulty: item.difficulty,
    topics: [item.domain],
    servedBy: 'focused',
    ...(media ? {
      imageUrl: media.imageUrl,
      imageKey: media.imageUrl,
      imageRole: 'prompt' as const,
      imageMeta: {
        accessTier: 'public' as const,
        showWhen: media.showWhen,
        class: media.class,
        altPolicy: 'generic' as const,
        preAnswerAlt: media.preAnswerAlt,
        attributionText: media.attributionText,
        licenseUrl: media.licenseUrl,
        ...(media.sourcePageUrl ? { sourcePageUrl: media.sourcePageUrl } : {}),
        ...(media.modality ? { modality: media.modality } : {}),
      },
    } : {}),
    ...(args.hook ? { decisionContext: { cohortHook: true } } : {}),
  };
}

/** A Cohort module card: graded by its opaque delivery, never by a card id. */
export function mapCohortCardToUnified(
  item: CohortCardSessionItem,
  args: { rotation: string },
): UnifiedItem {
  return {
    type: 'card',
    id: item.deliveryId,
    deliveryId: item.deliveryId,
    front: item.front,
    back: item.back,
    backs: null,
    context: item.context,
    attribution: item.attribution,
    ...(item.media ? {
      publicAnatomyMedia: {
        figureId: item.media.figureId,
        target: item.media.target,
        role: item.media.role,
        preAnswerAlt: item.media.preAnswerAlt,
        postAnswerAlt: item.media.postAnswerAlt,
        attribution: item.attribution,
      },
    } : {}),
    sourceComponent: 'KeyPoint',
    rotation: args.rotation,
    week: null,
    topics: [item.domain],
    servedBy: 'focused',
  };
}
