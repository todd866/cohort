import { createHash } from 'node:crypto';
import { isCardDueForSelection } from '@/lib/knowledge/card-due-eligibility';
import {
  gradeTypeX,
  missedStatementsForKType,
  normaliseFactKey,
  responseFormatOfOptions,
} from '@/lib/question-bank/statement-items';
/**
 * Statement scaffolds: the teaching cards a module serves after a statement miss.
 *
 * GSSE and NSx sessions are questions-only (exam-only-modules.ts). The one
 * exception is a scaffold card for a statement the learner just got wrong.
 * USyd rotations (cah, pwh, paam, critical-care) use the same tag to link a
 * card after a miss, and keep serving their ordinary cards and questions.
 * docs/superpowers/specs/2026-10-01-surgical-exam-realism-design.md, section 4:
 * "After a miss: serve the scaffolds for the missed statements next, in the
 * same session. The exact item returns on its normal spacing."
 *
 * The link is a naming convention, so nobody maintains a list of stableIds. A
 * scaffold is a card in the module's rotation whose `topics` hold the module's
 * tag (below) and the `factKey` of every statement it teaches, spelled as in
 * the `*.statements.json` file. Matching uses the bank's own normaliser, so
 * capitals or doubled spaces in a topic still match.
 *
 * A miss marks the chosen cards on the learner's CardProgress row (the marker
 * below) and makes them due now, the same due-now write the card-side scaffold
 * queue makes. The session admits a card only while that marker is live: due,
 * unreviewed since the miss, and recent; and offers it once per lease. A
 * scaffold that comes due later on its own spacing carries no live marker, so
 * it is never served as a test item.
 *
 * The marker lives in CardProgress.reviewContext, a JSON column nothing else
 * interprets (recordCardReview replaces it on a timed review; the guest
 * progress claim copies it), so no migration was needed. If scaffolds grow
 * other queue states, a dedicated table is the better home.
 */

const TAG_BY_ROTATION: ReadonlyMap<string, string> = new Map([
  ['neurosurg', 'nsx-scaffold'],
  ['surgical-sciences', 'gsse-scaffold'],
  ['cah', 'cah-scaffold'],
  ['pwh', 'pwh-scaffold'],
  ['paam', 'paam-scaffold'],
  ['critical-care', 'cc-scaffold'],
]);

/**
 * The topic that marks a card as a statement scaffold for this rotation.
 * Null when the rotation has no statement scaffolds. USyd rotations keep
 * their cards and single-best-answer questions; the tag only links a card
 * that should follow a missed statement.
 */
export function statementScaffoldTag(rotation: string | null | undefined): string | null {
  if (!rotation) return null;
  return TAG_BY_ROTATION.get(rotation) ?? null;
}

/** Most cards one miss may queue. */
export const STATEMENT_SCAFFOLDS_PER_MISS = 3;

/**
 * How long a queued scaffold stays servable: remediation for this sitting and
 * the next, not standalone teaching days later. The same window the session
 * uses to re-offer a delivered, unanswered question (unified-session-pending-
 * questions.ts). A new miss on the fact queues it afresh.
 */
export const STATEMENT_SCAFFOLD_LIVE_MS = 48 * 60 * 60 * 1000;

/**
 * Once offered, a scaffold is not offered again for this long. Skipping a card
 * (S) records nothing, so without the lease a skipped scaffold would return on
 * every new request; with it, at most once a sitting until reviewed or expired.
 * The lease is claimed atomically, so two tabs cannot both serve it.
 */
export const STATEMENT_SCAFFOLD_OFFER_LEASE_MS = 12 * 60 * 60 * 1000;

/** A marker stamped slightly ahead of this instance's clock is still valid. */
const QUEUE_CLOCK_SKEW_MS = 5 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStatementTruths(raw: unknown): Array<{ isTrue: boolean; factKey: string }> | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const rows: Array<{ isTrue: boolean; factKey: string }> = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.isTrue !== 'boolean' || typeof entry.factKey !== 'string') return null;
    const factKey = normaliseFactKey(entry.factKey);
    if (!factKey.replace(/\|/g, '')) return null;
    rows.push({ isTrue: entry.isTrue, factKey });
  }
  return rows;
}

/**
 * The fact keys of the statements a graded answer got wrong, in statement order.
 *
 * Type X: every statement judged wrongly. K-type: the statements whose truth
 * the chosen letter misstates. A skip (null) is not a graded answer and a
 * single best answer item has no statements, so both return nothing, as does
 * anything malformed: the caller queues nothing rather than guessing.
 */
export function misjudgedStatementFactKeys(
  options: unknown,
  statementsRaw: unknown,
  selectedOption: string | null,
): string[] {
  if (selectedOption === null) return [];
  const statements = readStatementTruths(statementsRaw);
  if (!statements) return [];
  const format = responseFormatOfOptions(options);
  let missed: number[];
  if (format === 'typeX') {
    const grade = gradeTypeX(options, selectedOption);
    if (!grade) return [];
    missed = grade.missed;
  } else if (format === 'kType') {
    missed = missedStatementsForKType(statements.map((s) => s.isTrue), selectedOption);
  } else {
    return [];
  }
  return [...new Set(missed.map((index) => statements[index].factKey))];
}

/** For each wanted fact key, the cards whose topics carry it. */
export function scaffoldCardsByFactKey(
  cards: ReadonlyArray<{ id: string; topics: readonly string[] }>,
  factKeys: readonly string[],
): Map<string, string[]> {
  const wanted = new Set(factKeys.map(normaliseFactKey));
  const byKey = new Map<string, string[]>();
  for (const card of cards) {
    const keys = new Set(card.topics.filter((topic) => topic.includes('|')).map(normaliseFactKey));
    for (const key of keys) {
      if (!wanted.has(key)) continue;
      const ids = byKey.get(key) ?? [];
      if (!ids.includes(card.id)) ids.push(card.id);
      byKey.set(key, ids);
    }
  }
  return byKey;
}

/** The learner's progress on a candidate scaffold; absent when never seen. */
export interface ScaffoldProgress {
  nextDueAt: Date;
  totalReviews: number;
  suppressed: boolean;
  status: string;
  viewsToday: number;
  viewsTodayDate: Date | null;
}

function seededRank(seed: string, value: string): string {
  return createHash('sha256').update(`${seed}:${value}`).digest('hex');
}

/**
 * Pick at most `cap` cards to queue for one miss.
 *
 * Every misjudged statement gets a card before any gets a second. Within a
 * statement: cards the learner has never reviewed first, then the most overdue.
 * The seed varies per miss and breaks ties, so neither candidate order nor
 * statement order decides which card wins (.claude/rules/repetition-guards.md).
 * Suppressed and retired cards, and cards already seen twice today, are never
 * queued, as in the card-side scaffold queue. At most one card per variant
 * group: siblings are served instead of each other (.claude/rules/variant-grouping.md).
 */
export function chooseStatementScaffolds(input: {
  factKeys: readonly string[];
  candidatesByFactKey: ReadonlyMap<string, readonly string[]>;
  progressByCardId: ReadonlyMap<string, ScaffoldProgress>;
  variantGroupByCardId?: ReadonlyMap<string, string | null>;
  now: Date;
  seed: string;
  cap?: number;
}): string[] {
  const { candidatesByFactKey, progressByCardId, now, seed } = input;
  const cap = input.cap ?? STATEMENT_SCAFFOLDS_PER_MISS;
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const eligible = (id: string): boolean => {
    const progress = progressByCardId.get(id);
    if (!progress) return true;
    if (progress.suppressed || progress.status === 'retired') return false;
    const viewsToday = progress.viewsTodayDate && progress.viewsTodayDate >= todayStart
      ? progress.viewsToday
      : 0;
    return viewsToday < 2;
  };
  const neverReviewed = (id: string): boolean => (progressByCardId.get(id)?.totalReviews ?? 0) === 0;
  const dueMs = (id: string): number => progressByCardId.get(id)?.nextDueAt.getTime() ?? Number.NEGATIVE_INFINITY;
  const compare = (a: string, b: string): number => {
    const aNew = neverReviewed(a);
    const bNew = neverReviewed(b);
    if (aNew !== bNew) return aNew ? -1 : 1;
    if (!aNew && dueMs(a) !== dueMs(b)) return dueMs(a) - dueMs(b);
    return seededRank(seed, a).localeCompare(seededRank(seed, b));
  };

  const ranked = new Map<string, string[]>();
  for (const key of new Set(input.factKeys)) {
    const ids = [...new Set(candidatesByFactKey.get(key) ?? [])].filter(eligible).sort(compare);
    if (ids.length > 0) ranked.set(key, ids);
  }
  const keys = [...ranked.keys()].sort((a, b) => seededRank(seed, a).localeCompare(seededRank(seed, b)));

  const chosen: string[] = [];
  const chosenGroups = new Set<string>();
  const taken = (id: string): boolean => {
    const group = input.variantGroupByCardId?.get(id);
    return chosen.includes(id) || (!!group && chosenGroups.has(group));
  };
  const next = new Map(keys.map((key) => [key, 0]));
  while (chosen.length < cap) {
    let added = false;
    for (const key of keys) {
      if (chosen.length >= cap) break;
      const ids = ranked.get(key) ?? [];
      let index = next.get(key) ?? 0;
      while (index < ids.length && taken(ids[index])) index += 1;
      if (index < ids.length) {
        chosen.push(ids[index]);
        const group = input.variantGroupByCardId?.get(ids[index]);
        if (group) chosenGroups.add(group);
        added = true;
        index += 1;
      }
      next.set(key, index);
    }
    if (!added) break;
  }
  return chosen;
}

/** Where the marker lives inside CardProgress.reviewContext. */
export const STATEMENT_SCAFFOLD_MARKER_KEY = 'statementScaffold';

/** "A miss queued this card": written by the miss, consumed by the next review. */
export interface StatementScaffoldMarker {
  /** Server time of the miss. Bounds how long the card stays live. */
  queuedAt: string;
  /** The exam-only module whose session may serve it. */
  rotation: string;
  /** The item that was missed, for audit. */
  questionId: string;
  /**
   * CardProgress.totalReviews when queued. Any applied review increments it,
   * which consumes the marker. Counting reviews rather than comparing
   * lastReview with queuedAt keeps client clocks out of it: a review's time is
   * the learner's action time, which may lag the server's by days offline.
   */
  reviewsAtQueue: number;
  /** Server time it was last served; absent until then. Leases the next offer. */
  offeredAt?: string;
}

/** The review context with the marker set (a new miss: any earlier offer is forgotten). */
export function withStatementScaffoldMarker(
  reviewContext: unknown,
  marker: StatementScaffoldMarker,
): JsonRecord {
  return { ...(isRecord(reviewContext) ? reviewContext : {}), [STATEMENT_SCAFFOLD_MARKER_KEY]: marker };
}

/** The review context with the marker's offer stamped; everything else is kept. */
export function withStatementScaffoldOffer(reviewContext: unknown, offeredAt: Date): JsonRecord {
  const base = isRecord(reviewContext) ? reviewContext : {};
  const marker = isRecord(base[STATEMENT_SCAFFOLD_MARKER_KEY]) ? base[STATEMENT_SCAFFOLD_MARKER_KEY] as JsonRecord : {};
  return { ...base, [STATEMENT_SCAFFOLD_MARKER_KEY]: { ...marker, offeredAt: offeredAt.toISOString() } };
}

export function readStatementScaffoldMarker(reviewContext: unknown): StatementScaffoldMarker | null {
  if (!isRecord(reviewContext)) return null;
  const marker = reviewContext[STATEMENT_SCAFFOLD_MARKER_KEY];
  if (!isRecord(marker)) return null;
  const { queuedAt, rotation, questionId, reviewsAtQueue, offeredAt } = marker;
  if (typeof queuedAt !== 'string' || typeof rotation !== 'string' || typeof questionId !== 'string') return null;
  if (typeof reviewsAtQueue !== 'number' || !Number.isSafeInteger(reviewsAtQueue) || reviewsAtQueue < 0) return null;
  if (offeredAt !== undefined && typeof offeredAt !== 'string') return null;
  return { queuedAt, rotation, questionId, reviewsAtQueue, ...(offeredAt !== undefined ? { offeredAt } : {}) };
}

/** The progress fields that decide whether a queued scaffold may be served. */
export interface StatementScaffoldDeliveryRow {
  nextDueAt: Date;
  totalReviews: number;
  suppressed: boolean;
  status: string;
  leechSuppressedUntil: Date | null;
  reviewContext: unknown;
}

/**
 * Due for this learner because of a miss in this module: due, carrying a marker
 * from this module, unreviewed since, and queued within the live window.
 */
export function isStatementScaffoldLive(
  row: StatementScaffoldDeliveryRow,
  rotation: string,
  now: Date,
  liveMs: number = STATEMENT_SCAFFOLD_LIVE_MS,
): boolean {
  if (row.suppressed || row.status === 'retired') return false;
  if (row.leechSuppressedUntil && row.leechSuppressedUntil.getTime() > now.getTime()) return false;
  if (!isCardDueForSelection(row.nextDueAt, now)) return false;
  const marker = readStatementScaffoldMarker(row.reviewContext);
  if (!marker || marker.rotation !== rotation) return false;
  if (row.totalReviews !== marker.reviewsAtQueue) return false;
  const queuedMs = Date.parse(marker.queuedAt);
  if (!Number.isFinite(queuedMs)) return false;
  const ageMs = now.getTime() - queuedMs;
  return ageMs >= -QUEUE_CLOCK_SKEW_MS && ageMs <= liveMs;
}

/** Live, and not offered within the lease. */
export function isStatementScaffoldOfferable(
  row: StatementScaffoldDeliveryRow,
  rotation: string,
  now: Date,
  leaseMs: number = STATEMENT_SCAFFOLD_OFFER_LEASE_MS,
): boolean {
  if (!isStatementScaffoldLive(row, rotation, now)) return false;
  const offeredAt = readStatementScaffoldMarker(row.reviewContext)?.offeredAt;
  if (offeredAt === undefined) return true;
  const offeredMs = Date.parse(offeredAt);
  return Number.isFinite(offeredMs) && now.getTime() - offeredMs >= leaseMs;
}
