import { questionImageIsPromptWithLookup } from '@/lib/figures/prompt-policy';
import { lookupServingSidecar } from '@/lib/figures/serving-index';

export interface QuestionMediaSnapshot {
  id: string;
  imageUrl?: string | null;
  imageCaption?: string | null;
  imageRole?: string | null;
}

export interface ReinforcementCardMediaSnapshot {
  stableId?: string | null;
  imageUrl?: string | null;
  imageCaption?: string | null;
  imageRole?: string | null;
}

export interface ReinforcementMediaOverlayEntry {
  imageUrl: string;
  imageCaption?: string | null;
  imageRole?: string | null;
}

function mediaFieldsEqual(
  left: Pick<QuestionMediaSnapshot, 'imageUrl' | 'imageCaption' | 'imageRole'>,
  right: Pick<QuestionMediaSnapshot, 'imageUrl' | 'imageCaption' | 'imageRole'>,
): boolean {
  return (left.imageUrl ?? null) === (right.imageUrl ?? null)
    && (left.imageCaption ?? null) === (right.imageCaption ?? null)
    && (left.imageRole ?? null) === (right.imageRole ?? null);
}

/**
 * Find existing primary reinforcement cards whose media differs from their
 * source-owned question in the seed corpus.
 *
 * Question content hashes intentionally cover the assessed text only. Including
 * image fields in those hashes would create a new ContentVersion for every
 * question when the hash contract changes. The seed uses this narrow media
 * comparison instead so image-only additions, replacements, caption edits and
 * removals still refresh their derived `qcard:*` rows without version churn.
 * Comparing the qcard after the Question upsert makes this idempotent across a
 * failed/retried seed: stale qcard media remains detectable until it is fixed.
 */
export function findReinforcementMediaDriftQuestionIds(
  desired: QuestionMediaSnapshot[],
  existingCards: ReinforcementCardMediaSnapshot[],
  overlay: ReadonlyMap<string, ReinforcementMediaOverlayEntry> = new Map(),
): string[] {
  const desiredByStableId = new Map(
    desired.map((question) => {
      const stableId = `qcard:${question.id}`;
      // Question-authored media wins. A qcard overlay is the same fallback
      // applied by applyCardImageOverlayToQcards: it only fills an otherwise
      // empty image slot. Compare against that effective final state so the
      // seed does not clear and reapply every intentional qcard overlay.
      const overlayEntry = !question.imageUrl ? overlay.get(stableId) : undefined;
      const effectiveImageUrl = overlayEntry?.imageUrl ?? question.imageUrl ?? null;
      const authoredImageRole = overlayEntry?.imageRole ?? question.imageRole;
      const effectiveImageRole = questionImageIsPromptWithLookup(
        authoredImageRole,
        effectiveImageUrl,
        lookupServingSidecar,
      ) ? 'prompt' : null;
      return [stableId, {
        ...question,
        imageUrl: effectiveImageUrl,
        imageCaption: overlayEntry
          ? (overlayEntry.imageCaption ?? null)
          : (question.imageCaption ?? null),
        imageRole: effectiveImageRole,
      }] as const;
    }),
  );
  const existingStableIds = new Set(
    existingCards.flatMap((card) => card.stableId ? [card.stableId] : []),
  );
  const driftQuestionIds = new Set<string>();

  for (const card of existingCards) {
    if (!card.stableId) continue;
    const question = desiredByStableId.get(card.stableId);
    if (question !== undefined && !mediaFieldsEqual(card, question)) {
      driftQuestionIds.add(question.id);
    }
  }

  for (const [stableId, question] of desiredByStableId) {
    if (question.imageRole === 'prompt' && !existingStableIds.has(stableId)) {
      driftQuestionIds.add(question.id);
    }
  }

  return [...driftQuestionIds].sort();
}
