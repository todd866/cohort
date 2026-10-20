/**
 * One learner's reviews of one card. Pure shaping, plus a read that refuses
 * to query until it has that learner's id. Response time uses the same 60s
 * cap as the statistics page.
 */
import { ANSWER_TIME_CAP_MS, GRADES, gradeOf, sydneyDay } from './stats-model';

export const CARD_HISTORY_LIMIT = 40;
const CARD_HISTORY_FETCH = CARD_HISTORY_LIMIT + 1;
const MS_PER_DAY = 86_400_000;

const GRADE_LABEL = new Map(GRADES.map((grade) => [grade.id, grade.label]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface CardReviewEvent {
  id: string;
  at: string | Date;
  quality: number | null;
  responseMs: number | null;
}

export interface CardHistoryRow {
  id: string;
  /** Sydney civil date, `YYYY-MM-DD`. */
  date: string;
  grade: string;
  /** Seconds, each answer capped at 60. Null when the review was not timed. */
  responseSeconds: number | null;
  /** Elapsed days since the previous review. Null on the first one we can see. */
  intervalDays: number | null;
}

interface CardHistoryDb {
  learningEvent: {
    findMany: (args: {
      where: { userId: string; sourceType: 'card'; sourceId: string; eventType: 'card_reviewed' };
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }];
      take: number;
      select: { id: true; timestamp: true; quality: true; responseMs: true };
    }) => Promise<Array<{ id: string; timestamp: Date; quality: number | null; responseMs: number | null }>>;
  };
}

/** Newest first. Events beyond `limit` stay in the list only so the oldest shown row still has its interval. */
export function buildCardHistory(events: readonly CardReviewEvent[], limit = CARD_HISTORY_LIMIT): CardHistoryRow[] {
  const sorted = events
    .map((event) => ({ event, at: new Date(event.at).getTime() }))
    .filter((row) => Number.isFinite(row.at))
    .sort((a, b) => a.at - b.at || a.event.id.localeCompare(b.event.id));
  const shown = sorted.slice(-limit);
  const anchor = sorted.length > shown.length ? sorted[sorted.length - shown.length - 1] : null;
  const rows = shown.map((current, index) => {
    const previous = index === 0 ? anchor?.at ?? null : shown[index - 1].at;
    const ms = current.event.responseMs;
    const capped = ms == null || !Number.isFinite(ms) ? null : Math.min(ANSWER_TIME_CAP_MS, Math.max(0, ms));
    const grade = gradeOf(current.event.quality);
    return {
      id: current.event.id,
      date: sydneyDay(new Date(current.at)),
      grade: grade ? GRADE_LABEL.get(grade) ?? '–' : '–',
      responseSeconds: capped == null ? null : Math.round(capped / 1000),
      intervalDays: previous == null ? null : (current.at - previous) / MS_PER_DAY,
    };
  });
  return rows.reverse();
}

export function formatHistoryDate(isoDay: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!match) return isoDay;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return isoDay;
  return `${Number(match[3])} ${month} ${match[1].slice(2)}`;
}

export function formatResponseSeconds(seconds: number | null): string {
  return seconds == null ? '–' : `${seconds}s`;
}

export function formatIntervalDays(days: number | null): string {
  if (days == null || !Number.isFinite(days)) return '–';
  if (days < 1 / 24) return `${Math.max(0, Math.round(days * 24 * 60))}m`;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  const rounded = days < 10 ? Math.round(days * 10) / 10 : Math.round(days);
  return `${rounded}d`;
}

/** The signed-in learner's reviews of this card, newest first, one extra row for the interval anchor. No query without a user id. */
export async function loadOwnCardReviews(
  db: CardHistoryDb,
  userId: string | null | undefined,
  cardId: string,
): Promise<CardReviewEvent[]> {
  if (!userId || !cardId) return [];
  const rows = await db.learningEvent.findMany({
    where: {
      userId,
      sourceType: 'card',
      sourceId: cardId,
      eventType: 'card_reviewed',
    },
    orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    take: CARD_HISTORY_FETCH,
    select: { id: true, timestamp: true, quality: true, responseMs: true },
  });
  return rows.map((row) => ({
    id: row.id,
    at: row.timestamp.toISOString(),
    quality: row.quality,
    responseMs: row.responseMs,
  }));
}
