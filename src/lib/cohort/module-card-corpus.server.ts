import 'server-only';

import { createHash } from 'node:crypto';

import checkedInRelease from '../../../open-content/modules/cards-release-v1.json';
import { loadCohortModuleCardsFromDisk } from '@/lib/content/cohort-card-corpus';
import { prisma, type ExtendedPrismaClient } from '@/lib/prisma';
import {
  COHORT_MODULE_ROTATION,
  cohortCardServingFingerprint,
  type CohortCardRelease,
  type CohortCardServingRow,
} from '@/lib/content/cohort-mirror-cards';

/**
 * The Cohort module CARD corpus: rights-clean md3 cards mirrored as their own
 * `cohort-open` rows (docs/designs/2026-09-23-cohort-mirror.md, Increment 3).
 *
 * The checked-in release decides, the database is only a pointer: a row is
 * served only if it is a release member and matches its released serving
 * fingerprint exactly, so an edit made in the database, or a stale seed, can
 * never reach a learner. Text cards only for now: a card with an image is
 * refused until the host serves card images through the open-figure gate.
 */

/** A stored Card row as this loader selects it. */
export type CohortCardRow = CohortCardServingRow & { id: string };

export interface CohortServableCard {
  /** Card.id: what ServeDecision.itemId and CardProgress.cardId hold. */
  id: string;
  stableId: string;
  discipline: string;
  front: string;
  back: string;
  context: string | null;
  variantGroupId: string | null;
  releaseFingerprint: string;
  contentHash: string;
  /** Public authored scaffold rung; never exposes private concept metadata. */
  complexity?: number;
}

export type CohortCardRefusal =
  | 'not-release-manifest-member'
  | 'not-cohort-module-row'
  | 'image-not-served'
  | 'release-content-drift';

const CHECKED_IN_RELEASE = checkedInRelease as CohortCardRelease;
const CHECKED_IN_CARDS = loadCohortModuleCardsFromDisk();
const RELEASE_COMPLEXITY = new Map(CHECKED_IN_CARDS.cards.map(({ card }) => [card.id, card.complexity]));
export const COHORT_CARD_RELEASE_LOADABLE = CHECKED_IN_CARDS.errors.length === 0;
const CARD_ID = /^cohort:([a-z-]+):c-[0-9a-f]{12}:v1$/;
const CARD_SELECT = {
  id: true, stableId: true, rotation: true, cardType: true, front: true, back: true, context: true,
  imageUrl: true, imageCaption: true, moduleNodes: true, variantGroupId: true, variantIndex: true,
  complexity: true,
} as const;

/** sha256 of what a learner reads on the card; frozen into each delivery. */
export function cohortCardContentHash(card: Pick<CohortCardRow, 'front' | 'back' | 'context'>): string {
  return createHash('sha256').update(JSON.stringify([card.front, card.back, card.context ?? null])).digest('hex');
}

/** Pure: decide each stored row against the release. Exported for the contract test. */
export function buildCohortModuleCardCorpus(
  rows: ReadonlyArray<CohortCardRow>,
  release: CohortCardRelease,
): { cards: CohortServableCard[]; refused: Array<{ stableId: string; reason: CohortCardRefusal }> } {
  const released = new Set(release.cardIds);
  const cards: CohortServableCard[] = [];
  const refused: Array<{ stableId: string; reason: CohortCardRefusal }> = [];
  for (const row of rows) {
    const refuse = (reason: CohortCardRefusal) => refused.push({ stableId: row.stableId, reason });
    const fingerprint = release.cardFingerprints[row.stableId];
    if (!released.has(row.stableId) || !fingerprint) { refuse('not-release-manifest-member'); continue; }
    const discipline = CARD_ID.exec(row.stableId)?.[1];
    if (
      !discipline || row.rotation !== COHORT_MODULE_ROTATION || row.cardType !== 'cloze'
      || !row.moduleNodes.includes(`cohort/${discipline}`) || row.front.split('[___]').length !== 2
    ) { refuse('not-cohort-module-row'); continue; }
    if (row.imageUrl) { refuse('image-not-served'); continue; }
    if (cohortCardServingFingerprint(row) !== fingerprint) { refuse('release-content-drift'); continue; }
    cards.push({
      id: row.id,
      stableId: row.stableId,
      discipline,
      front: row.front,
      back: row.back,
      context: row.context,
      variantGroupId: row.variantGroupId,
      releaseFingerprint: fingerprint,
      contentHash: cohortCardContentHash(row),
      complexity: RELEASE_COMPLEXITY.get(row.stableId),
    });
  }
  return { cards, refused };
}

type CardStore = Pick<ExtendedPrismaClient, 'card'>;

/** One discipline's servable cards. One indexed read; no history. */
export async function loadCohortModuleCardCorpus(
  store: CardStore = prisma,
  discipline?: string,
  release: CohortCardRelease = CHECKED_IN_RELEASE,
): Promise<{ cards: CohortServableCard[]; refused: Array<{ stableId: string; reason: CohortCardRefusal }> }> {
  const rows = await store.card.findMany({
    where: {
      rotation: COHORT_MODULE_ROTATION,
      deletedAt: null,
      shelvedAt: null,
      stableId: { startsWith: discipline ? `cohort:${discipline}:c-` : 'cohort:' },
    },
    select: CARD_SELECT,
    orderBy: { stableId: 'asc' },
  });
  return buildCohortModuleCardCorpus(rows as CohortCardRow[], release);
}

/**
 * Released, seeded, live module cards per discipline, for the topic catalogue
 * (never the turn path). One stableId-only read; membership is the release's,
 * so a topic appears only once its cards are actually in the database.
 */
export async function countServableModuleCards(
  store: CardStore = prisma,
  release: CohortCardRelease = CHECKED_IN_RELEASE,
): Promise<Map<string, number>> {
  const rows = await store.card.findMany({
    where: { rotation: COHORT_MODULE_ROTATION, deletedAt: null, shelvedAt: null, stableId: { startsWith: 'cohort:' } },
    select: { stableId: true },
  });
  const released = new Set(release.cardIds);
  const counts = new Map<string, number>();
  for (const { stableId } of rows) {
    const discipline = stableId && released.has(stableId) ? CARD_ID.exec(stableId)?.[1] : undefined;
    if (discipline) counts.set(discipline, (counts.get(discipline) ?? 0) + 1);
  }
  return counts;
}

/**
 * The next card for one learner in one module: the most overdue card first,
 * then the first unseen one in release (id) order. The cards this journey
 * served most recently (newest first) and their siblings are held back; when
 * that would hold back every card in a small module, only the card just served
 * and its siblings are. Null when nothing qualifies.
 */
export function selectCohortModuleCard(input: {
  cards: readonly CohortServableCard[];
  progress: ReadonlyArray<{ cardId: string; nextDueAt: Date }>;
  /** This journey's recent card deliveries, newest first. */
  recentCardIds: readonly string[];
  recentGroups: ReadonlySet<string>;
  now: Date;
  /** -2 is the only level that restricts cards to C1 scaffolds. */
  challengeLevel?: number;
  /** Reviewed media families recently shown to this learner, including prior journeys. */
  recentMediaFamilies?: ReadonlySet<string>;
  /** Maps an admitted card to its reviewed media family, or null for text-only cards. */
  mediaFamilyForCard?: (card: CohortServableCard) => string | null;
}): { card: CohortServableCard; reason: 'due' | 'new' } | null {
  const pick = (heldIds: ReadonlySet<string>, heldGroups: ReadonlySet<string>) => {
    const eligible = input.cards.filter((card) => (
      (input.challengeLevel !== -2 || card.complexity === 1)
      &&
      !heldIds.has(card.id) && !(card.variantGroupId && heldGroups.has(card.variantGroupId))
      && !(input.recentMediaFamilies?.size && input.mediaFamilyForCard?.(card) && input.recentMediaFamilies.has(input.mediaFamilyForCard(card)!))
    ));
    const dueAt = new Map(input.progress.map((p) => [p.cardId, p.nextDueAt.getTime()]));
    const due = eligible
      .filter((card) => (dueAt.get(card.id) ?? Infinity) <= input.now.getTime())
      .sort((a, b) => dueAt.get(a.id)! - dueAt.get(b.id)! || a.stableId.localeCompare(b.stableId));
    if (due[0]) return { card: due[0], reason: 'due' as const };
    const fresh = eligible.find((card) => !dueAt.has(card.id));
    return fresh ? { card: fresh, reason: 'new' as const } : null;
  };
  const chosen = pick(new Set(input.recentCardIds), input.recentGroups);
  if (chosen || input.recentCardIds.length <= 1) return chosen;
  const last = input.cards.find((card) => card.id === input.recentCardIds[0]);
  return pick(new Set(input.recentCardIds.slice(0, 1)), new Set(last?.variantGroupId ? [last.variantGroupId] : []));
}
