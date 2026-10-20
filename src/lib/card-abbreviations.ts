import crypto from 'node:crypto';
import type { GeneratedCard } from './card-generator';

// Public distribution deliberately has no private reviewed card sidecar.
export const CARD_ABBREVIATIONS_PATH = '';

export interface CardAbbreviationRecord {
  rotation: string;
  sourceFile: string;
  bodyHash: string;
  abbreviations: Record<string, string>;
}

export interface CardAbbreviationSidecar {
  version: 1;
  cards: Record<string, CardAbbreviationRecord>;
}

export function cardBodyHash(card: Pick<GeneratedCard, 'front' | 'back' | 'backs' | 'context'>): string {
  const body = JSON.stringify({
    front: card.front,
    back: card.back,
    backs: card.backs ?? null,
    context: card.context ?? null,
  });
  return `sha256:${crypto.createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

export function loadCardAbbreviations(): CardAbbreviationSidecar {
  return { version: 1, cards: {} };
}

/** Public distribution has no private card abbreviation maps to apply. */
export function applyCardAbbreviations(
  _cards: Array<GeneratedCard & { stableId: string }>,
  _sidecar: CardAbbreviationSidecar = loadCardAbbreviations(),
  _options: { scopeKeys?: ReadonlySet<string> } = {},
): number {
  void _cards;
  void _sidecar;
  void _options;
  return 0;
}
