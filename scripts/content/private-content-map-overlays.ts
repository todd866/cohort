export type PrivateContentMapCardInput = { stableId: string };
export type PrivateContentMapQuestionInput = object;

export interface PrivateContentMapOverlayResult {
  cardsUpdated: number;
  questionsUpdated: number;
}

/** Public build: deployment-private content-map overlays are intentionally absent. */
export function applyPrivateContentMapOverlays(
  _cards: PrivateContentMapCardInput[],
  _questions: PrivateContentMapQuestionInput[],
): PrivateContentMapOverlayResult {
  void _cards;
  void _questions;
  return { cardsUpdated: 0, questionsUpdated: 0 };
}
