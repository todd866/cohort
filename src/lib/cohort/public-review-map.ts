import type { Step1SessionItem } from '@/lib/usmle/step1-contract';
import type { UnifiedItem } from '@/lib/study/unified-session-types';

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
