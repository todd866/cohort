/**
 * Pure classification for question-reinforcement (QR) card reconciliation.
 *
 * A QR card ("qcard") is a cloze auto-derived from a bank question. When the
 * source question changes, the qcard can drift out of sync — and unlike
 * question flags, nothing reconciles it on re-seed. Two failure modes:
 *
 *   - The question is no longer cloze-eligible (e.g. converted to an MCQ whose
 *     stem requires options). buildPrimaryCardDraft returns null → the qcard
 *     should be RETIRED (soft-deleted). This is the gap that left a stale
 *     "The diagnosis is [___]" cloze alive after its question became an MCQ —
 *     the old shelve-stale-qr-cards only inspected qcards with NO [___], so a
 *     valid-looking blanked cloze slipped through.
 *
 *   - The question still yields a cloze, but its content changed
 *     (computePrimaryCardUpdate returns a non-empty diff) → the qcard has
 *     DRIFTED and should be HEALED (updated in place).
 *
 * This module is the pure decision; scripts/content/shelve-stale-qr-cards.ts
 * supplies the desired-draft / drift inputs and applies the action.
 */

export type QrAction = 'retire' | 'heal' | 'clean';

export interface QrCardState {
  /** True when buildPrimaryCardDraft returned a draft (question still cloze-eligible). */
  desiredExists: boolean;
  /** Field names from computePrimaryCardUpdate — empty when the card is in sync. */
  driftFields: string[];
}

export function classifyQrCard(state: QrCardState): QrAction {
  if (!state.desiredExists) return 'retire';
  if (state.driftFields.length > 0) return 'heal';
  return 'clean';
}

export interface QrReconcileSummary {
  retire: number;
  heal: number;
  clean: number;
}

export function summarizeQr(actions: QrAction[]): QrReconcileSummary {
  const s: QrReconcileSummary = { retire: 0, heal: 0, clean: 0 };
  for (const a of actions) s[a]++;
  return s;
}
