import { logger } from '@/lib/logger';
import { proximityOverlayFor } from '@/lib/review/serve-conditioning';
import {
  substituteDueSlot,
  type DueCard,
  type SlotPools,
} from './repetition-slot';

/** Shadow-only record. `kind: 'keep'` is not recorded. */
export interface RepetitionSlotShadow {
  kind: 'substitute' | 'empty';
  wouldServeType: 'card' | 'question' | null;
  wouldServeId: string | null;
  step: 1 | 2 | 3 | null;
  reason: string;
  supplyEmpty: boolean;
  shadow: true;
}

export interface RepetitionSlotGrade {
  lastQuality: number | null;
  correctCount: number;
}

export interface RepetitionSlotCard {
  id: string;
  stableId?: string | null;
  variantGroupId: string | null;
  variantType: string | null;
  complexity: number;
}

export interface RepetitionSlotContext {
  grades: Map<string, DueCard>;
  pools: SlotPools;
}

let shadowFailureLogged = false;

function logShadowFailure(error: unknown): void {
  if (shadowFailureLogged) return;
  shadowFailureLogged = true;
  logger.warn('repetition-slot shadow failed', { error: String(error) });
}

/**
 * Evaluate a due card the learner last answered correctly. Returns null for
 * a keep (lastQuality <= 2) and for any thrown error, so serving is unchanged.
 */
export function repetitionSlotShadow(
  due: DueCard,
  pools: SlotPools,
): RepetitionSlotShadow | null {
  try {
    if (due.lastQuality === null || due.lastQuality <= 2) return null;
    const decision = substituteDueSlot(due, pools);
    if (decision.kind === 'keep') return null;
    if (decision.kind === 'substitute') {
      return {
        kind: 'substitute',
        wouldServeType: decision.itemType,
        wouldServeId: decision.id,
        step: decision.step,
        reason: decision.reason,
        supplyEmpty: false,
        shadow: true,
      };
    }
    return {
      kind: 'empty',
      wouldServeType: null,
      wouldServeId: null,
      step: null,
      reason: decision.reason,
      supplyEmpty: true,
      shadow: true,
    };
  } catch (error) {
    logShadowFailure(error);
    return null;
  }
}

export function shadowForDueId(
  cardId: string,
  context: RepetitionSlotContext | null | undefined,
): RepetitionSlotShadow | null {
  try {
    const due = context?.grades.get(cardId);
    if (!due || !context) return null;
    return repetitionSlotShadow(due, context.pools);
  } catch (error) {
    logShadowFailure(error);
    return null;
  }
}

export function buildRepetitionSlotContext(input: {
  rotation: string;
  cards: readonly RepetitionSlotCard[];
  grades: ReadonlyMap<string, RepetitionSlotGrade> | undefined;
  seenCardIds: Iterable<string>;
  variantGroupHistory: Iterable<Iterable<string>>;
  seenQuestionIds: Iterable<string>;
}): RepetitionSlotContext | null {
  try {
    if (!input.grades || input.grades.size === 0) return null;
    const cardsById = new Map(input.cards.map((card) => [card.id, card]));
    const grades = new Map<string, DueCard>();
    for (const [cardId, grade] of input.grades) {
      const card = cardsById.get(cardId);
      if (!card?.stableId) continue;
      grades.set(cardId, {
        cardId,
        stableId: card.stableId,
        variantGroupId: card.variantGroupId,
        variantType: card.variantType,
        complexity: card.complexity,
        lastQuality: grade.lastQuality,
        correctCount: grade.correctCount,
      });
    }
    if (grades.size === 0) return null;

    const seenCardIds = new Set<string>(input.seenCardIds);
    for (const ids of input.variantGroupHistory) {
      for (const id of ids) seenCardIds.add(id);
    }
    const overlay = proximityOverlayFor(input.rotation);
    const proximity = new Map<string, { q: string; sim: number }[]>();
    if (overlay?.cards) {
      for (const [stableId, links] of Object.entries(overlay.cards)) {
        proximity.set(stableId, links);
      }
    }
    return {
      grades,
      pools: {
        siblings: input.cards.map((card) => ({
          id: card.id,
          stableId: card.stableId ?? '',
          variantGroupId: card.variantGroupId,
          variantType: card.variantType,
          complexity: card.complexity,
        })),
        seenCardIds,
        proximity,
        seenQuestionIds: new Set(input.seenQuestionIds),
        questionComplexity: new Map(),
      },
    };
  } catch (error) {
    logShadowFailure(error);
    return null;
  }
}

export interface DeliveredShadowCardMeta {
  stableId?: string | null;
  variantGroupId?: string | null;
  variantType?: string | null;
  complexity?: number | null;
}

/**
 * Stamp a shadow onto delivered cards that do not already carry one.
 *
 * A card the scheduler already shadowed keeps that record: its pools include
 * siblings and seen questions. A path that only has the due-egress grade and
 * the proximity file uses those, and never changes which ids are served.
 */
export function shadowDeliveredCards<T extends {
  type: string;
  id: string;
  repetitionSlot?: RepetitionSlotShadow | null;
  variantGroupId?: string | null;
  variantType?: string | null;
  complexity?: number | null;
}>(
  items: readonly T[],
  input: {
    rotation: string;
    grades: ReadonlyMap<string, { lastQuality: number | null; correctCount: number }>;
    cardMeta: ReadonlyMap<string, DeliveredShadowCardMeta>;
  },
): T[] {
  const seenCardIds = items.filter((item) => item.type === 'card').map((item) => item.id);
  let pools: SlotPools | null = null;
  return items.map((item) => {
    if (item.type !== 'card' || item.repetitionSlot) return item;
    const grade = input.grades.get(item.id);
    const meta = input.cardMeta.get(item.id);
    const stableId = meta?.stableId;
    if (!grade || !stableId) return item;
    pools ??= overlayOnlySlotPools(input.rotation, seenCardIds);
    const repetitionSlot = repetitionSlotShadow({
      cardId: item.id,
      stableId,
      variantGroupId: meta.variantGroupId ?? item.variantGroupId ?? null,
      variantType: meta.variantType ?? item.variantType ?? null,
      complexity: meta.complexity ?? item.complexity ?? 1,
      lastQuality: grade.lastQuality,
      correctCount: grade.correctCount,
    }, pools);
    return repetitionSlot ? { ...item, repetitionSlot } : item;
  });
}

export function shadowCardMetaFromSources(
  sources: Iterable<{
    type: string;
    id: string;
    stableId?: string | null;
    variantGroupId?: string | null;
    variantType?: string | null;
    complexity?: number | null;
  }>,
): Map<string, DeliveredShadowCardMeta> {
  const meta = new Map<string, DeliveredShadowCardMeta>();
  for (const source of sources) {
    if (source.type !== 'card') continue;
    meta.set(source.id, {
      stableId: source.stableId ?? null,
      variantGroupId: source.variantGroupId ?? null,
      variantType: source.variantType ?? null,
      complexity: source.complexity ?? null,
    });
  }
  return meta;
}

/** Pools for a path that has the due card but not the bulk candidate lists. */
export function overlayOnlySlotPools(
  rotation: string,
  seenCardIds: Iterable<string>,
): SlotPools {
  const proximity = new Map<string, { q: string; sim: number }[]>();
  try {
    const overlay = proximityOverlayFor(rotation);
    if (overlay?.cards) {
      for (const [stableId, links] of Object.entries(overlay.cards)) {
        proximity.set(stableId, links);
      }
    }
  } catch (error) {
    logShadowFailure(error);
  }
  return {
    siblings: [],
    seenCardIds: new Set(seenCardIds),
    proximity,
    // questionFamiliarity is not loaded on the review-filter path.
    seenQuestionIds: new Set(),
    questionComplexity: new Map(),
  };
}
