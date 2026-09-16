/**
 * Flag reconciliation logic.
 *
 * Card flags are stored on CardProgress.cardId. But card IDs are not stable:
 * any content edit changes a card's stableId (e.g. `mdx:<hash>:blank-1`),
 * which regenerates the card with a new id and soft-deletes the old row.
 * The CardProgress.flagged row keeps pointing at the soft-deleted old id, so
 * the flag becomes a zombie: it no longer corresponds to anything a user is
 * served, yet it lingers forever (unlike question flags, which the seeder
 * auto-clears on content change).
 *
 * Reconciliation classifies each flag from the state of its referenced card:
 *   - card still live            → keep (genuinely actionable)
 *   - card soft-deleted, but a live card shares its stableId
 *                                → relink the flag to the live twin (same
 *                                  content, re-IDed; the defect persists)
 *   - card soft-deleted, no twin → resolve (content was changed or removed)
 *   - card row missing entirely  → resolve (nothing to act on)
 *
 * This module is the pure decision; scripts/content/reconcile-flags.ts wires
 * it to Prisma and applies the actions.
 */

export interface FlagCardState {
  /** Whether the referenced Card row exists at all. */
  cardExists: boolean;
  /** Card.deletedAt — null/absent means the card is live and served. */
  deletedAt: Date | string | null;
  /** id of a live (non-deleted) card sharing this card's stableId, if any. */
  liveTwinId: string | null;
}

export type FlagAction =
  | { kind: 'keep-live' }
  | { kind: 'relink'; toCardId: string }
  | { kind: 'resolve'; reason: 'card-missing' | 'soft-deleted-no-twin' };

export function classifyFlag(state: FlagCardState): FlagAction {
  if (!state.cardExists) {
    return { kind: 'resolve', reason: 'card-missing' };
  }
  if (!state.deletedAt) {
    return { kind: 'keep-live' };
  }
  if (state.liveTwinId) {
    return { kind: 'relink', toCardId: state.liveTwinId };
  }
  return { kind: 'resolve', reason: 'soft-deleted-no-twin' };
}

export interface ReconcileSummary {
  keepLive: number;
  relink: number;
  resolveMissing: number;
  resolveNoTwin: number;
}

export function summarize(actions: FlagAction[]): ReconcileSummary {
  const s: ReconcileSummary = { keepLive: 0, relink: 0, resolveMissing: 0, resolveNoTwin: 0 };
  for (const a of actions) {
    if (a.kind === 'keep-live') s.keepLive++;
    else if (a.kind === 'relink') s.relink++;
    else if (a.reason === 'card-missing') s.resolveMissing++;
    else s.resolveNoTwin++;
  }
  return s;
}
