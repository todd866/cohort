import type { GeneratedCard } from '../card-generator';

export interface SplitWarning {
  kind: 'blank-back-mismatch';
  baseStableId: string;
  blankCount: number;
  backsLength: number;
  front: string;
}

export interface SplitResult {
  cards: GeneratedCard[];
  legacyAnchorStableIds: string[];
  warnings: SplitWarning[];
}

const BLANK_TOKEN = '[___]';

function countBlanks(front: string): number {
  return front.split(BLANK_TOKEN).length - 1;
}

export function splitClozeVariants(
  card: GeneratedCard,
  baseStableId: string,
): SplitResult {
  // Idempotency guard — must run first.
  // An already-split variant has variantGroupId set; never re-process it.
  if (card.variantGroupId != null) {
    return { cards: [card], legacyAnchorStableIds: [], warnings: [] };
  }

  const blankCount = countBlanks(card.front);
  const backs = card.backs ?? [];

  // Pass-through: 0 or 1 blank, no multi-back signal.
  if (blankCount <= 1 && backs.length <= 1) {
    return {
      cards: [{
        ...card,
        stableId: baseStableId,
        variantGroupId: null,
        variantIndex: null,
        variantType: null,
      }],
      legacyAnchorStableIds: [],
      warnings: [],
    };
  }

  if (blankCount !== backs.length) {
    return {
      cards: [{
        ...card,
        stableId: baseStableId,
        variantGroupId: null,
        variantIndex: null,
        variantType: null,
      }],
      legacyAnchorStableIds: [],
      warnings: [{
        kind: 'blank-back-mismatch',
        baseStableId,
        blankCount,
        backsLength: backs.length,
        front: card.front,
      }],
    };
  }

  // Positional split. Split on the [___] token (no regex, no replacement-string
  // magic). For variant index i, every blank j !== i is replaced with backs[j].
  const segments = card.front.split(BLANK_TOKEN); // length = blankCount + 1
  const variants: GeneratedCard[] = [];

  for (let i = 0; i < blankCount; i++) {
    const front = segments
      .map((seg, j) => {
        if (j >= blankCount) return seg; // tail segment
        return seg + (j === i ? BLANK_TOKEN : backs[j]);
      })
      .join('');

    variants.push({
      ...card,
      stableId: `${baseStableId}:blank-${i}`,
      front,
      back: backs[i],
      backs: null,
      variantGroupId: baseStableId,
      variantIndex: i,
      variantType: 'cloze-blank',
    });
  }

  return {
    cards: variants,
    legacyAnchorStableIds: [baseStableId],
    warnings: [],
  };
}
