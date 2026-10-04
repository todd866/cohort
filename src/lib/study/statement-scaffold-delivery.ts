import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { SHARED_CATALOG_CARD_SCOPE, findManyCards } from '@/lib/cards/read-repository.server';
import { getOpenIssueExclusions } from '@/lib/content-quality/open-issue-exclusions';
import { MODALITY_MAX_SAME_TYPE_RUN } from '@/lib/knowledge/modality-guard';
import { EXCLUDED_POOL_TOPICS } from './servable-pool';
import { checkServedItemContract } from './served-item-contract';
import { writeLiveServeDecisions } from './serve-decision-write';
import { logExposures, type CardDueExposureAudit } from './unified-session-helpers';
import { hydrateScheduledItems, loadScheduledItemHydrationData } from './unified-session-hydration';
import type { SessionContext, UnifiedItem } from './unified-session-types';
import {
  isStatementScaffoldOfferable,
  readStatementScaffoldMarker,
  statementScaffoldTag,
  withStatementScaffoldOffer,
  type StatementScaffoldDeliveryRow,
} from './statement-scaffolds';
import { isNativeExamScaffold } from './exam-only-modules';

/**
 * The exam-only boundary of every session batch, and where statement
 * scaffolds join it.
 *
 * This runs on every GSSE/NSx batch whichever lane built it, and does two things:
 *
 * 1. Keeps questions and native scaffold cards. Any other item a lane emitted
 *    is removed and logged as a defect, whatever the request asked for and
 *    whether or not the scaffold step below succeeds.
 * 2. Prepends this learner's statement scaffolds: cards a miss queued
 *    (statement-scaffolds.ts), so they arrive on the next refill ahead of its
 *    questions, without any lane learning to select cards. A card is admitted
 *    only after every gate the pool build applies is re-applied to its
 *    current rows: due now, current and servable, tagged for this module, not
 *    flagged, not already held, one per variant group (.claude/rules/
 *    repetition-guards.md). Each offer is claimed atomically and leased, so
 *    two requests cannot serve the same card and a skipped card does not
 *    return on the next request.
 *
 * Request path: two bounded reads, and nothing that aggregates history. The
 * module's tagged card ids (a GIN read, cached for a minute), then this
 * learner's progress on exactly those ids, which the (cardId, userId) unique
 * index answers. Hydration reads, and the claim writes, only the few rows
 * admitted. If any of it fails, the batch is served without scaffolds
 * (.claude/rules/hot-path-latency.md).
 *
 * Accounting: the lane recorded its own items' decisions before this runs, so
 * the scaffolds' ServeDecisions and exposures are written here, and the lane's
 * items are displayed up to STATEMENT_SCAFFOLDS_PER_BATCH places later than the
 * positions it recorded.
 */

/** At most this many scaffolds join one batch: a longer run of cards trips the walk audit. */
export const STATEMENT_SCAFFOLDS_PER_BATCH = MODALITY_MAX_SAME_TYPE_RUN;

/** Bound on the tagged-card read; the same cap the miss-side queue uses. */
const SCAFFOLD_SCAN_CAP = 5000;
const TAGGED_CARD_CACHE_MS = 60_000;
const taggedCardCache = new Map<string, { ids: readonly string[]; expiresAt: number }>();

/** Test hook: the tagged-card ids are cached per process. */
export function clearStatementScaffoldCardCache(): void {
  taggedCardCache.clear();
}

type JsonRecord = Record<string, unknown>;
type ScaffoldProgressRow = StatementScaffoldDeliveryRow & { cardId: string };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether scaffolds may join this request's batch. The learner's own narrowing
 * stays authoritative, as for practice-exam follow-ups (practice-scaffold-
 * selection.ts): a new-only, filtered, scoped or mode request is served
 * exactly as asked. (The questions-only boundary applies regardless.)
 */
export function permitsStatementScaffolds(ctx: SessionContext): boolean {
  return statementScaffoldTag(ctx.rotation) !== null
    && ctx.feedMode !== 'new-only'
    // Explicit question-only requests must remain question-only; after-miss
    // cards are reserved for the default mixed adaptive session.
    && ctx.typeFilter === null
    && ctx.reviewChallenge?.level !== 2
    && ctx.weekFilter === null
    && !ctx.difficultyFilter
    && !ctx.topicsFilter
    && !ctx.clusterFilter
    && !ctx.modulesFilter
    && !ctx.requestedMode
    && !ctx.mode
    && !ctx.reviewFilter;
}

async function taggedScaffoldCardIds(rotation: string, tag: string, nowMs: number): Promise<ReadonlySet<string>> {
  const cached = taggedCardCache.get(rotation);
  if (cached && cached.expiresAt > nowMs) return new Set(cached.ids);
  const rows = await findManyCards(SHARED_CATALOG_CARD_SCOPE, {
    where: {
      rotation,
      deletedAt: null,
      shelvedAt: null,
      topics: { has: tag },
      NOT: { topics: { hasSome: [...EXCLUDED_POOL_TOPICS] } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: SCAFFOLD_SCAN_CAP,
  });
  const ids = rows.map((row) => row.id);
  taggedCardCache.set(rotation, { ids, expiresAt: nowMs + TAGGED_CARD_CACHE_MS });
  return new Set(ids);
}

function seededRank(seed: string, value: string): string {
  return createHash('sha256').update(`${seed}:${value}`).digest('hex');
}

/** Compare-and-set the offer stamp on the context that was read. False: someone got there first. */
async function claimOffer(userId: string, row: ScaffoldProgressRow, now: Date): Promise<boolean> {
  const { count } = await prisma.cardProgress.updateMany({
    where: {
      userId,
      cardId: row.cardId,
      totalReviews: row.totalReviews,
      reviewContext: { equals: row.reviewContext as Prisma.InputJsonValue },
    },
    data: { reviewContext: withStatementScaffoldOffer(row.reviewContext, now) as Prisma.InputJsonValue },
  });
  return count === 1;
}

async function admitStatementScaffolds(ctx: SessionContext, tag: string, now: Date): Promise<UnifiedItem[]> {
  const taggedIds = await taggedScaffoldCardIds(ctx.rotation, tag, now.getTime());
  if (taggedIds.size === 0) return [];

  // Fail closed: if flagged content cannot be read, serve no scaffold.
  const [progressRows, openIssues] = await Promise.all([
    prisma.cardProgress.findMany({
      where: { userId: ctx.userId, cardId: { in: [...taggedIds] }, nextDueAt: { lte: now } },
      select: {
        cardId: true,
        nextDueAt: true,
        totalReviews: true,
        suppressed: true,
        status: true,
        leechSuppressedUntil: true,
        reviewContext: true,
      },
    }) as Promise<ScaffoldProgressRow[]>,
    getOpenIssueExclusions(),
  ]);

  const offerable = progressRows
    .filter((row) => taggedIds.has(row.cardId)
      && !ctx.clientExcludeCardSet.has(row.cardId)
      && !openIssues.cardIds.has(row.cardId)
      && isStatementScaffoldOfferable(row, ctx.rotation, now))
    .map((row) => ({
      row,
      queuedMs: Date.parse(readStatementScaffoldMarker(row.reviewContext)?.queuedAt ?? ''),
    }))
    // The most recent miss first: those are the statements the learner just
    // met. A ranking, not a fixed pick: an offered card is leased and a
    // reviewed one consumed, so the next batch takes the next ones.
    .sort((a, b) => (b.queuedMs - a.queuedMs)
      || seededRank(ctx.sessionId, a.row.cardId).localeCompare(seededRank(ctx.sessionId, b.row.cardId)));
  if (offerable.length === 0) return [];
  const rowsById = new Map(offerable.map(({ row }) => [row.cardId, row]));

  // Headroom for rows hydration refuses (deleted, unservable, image-gated).
  const scheduledItems = offerable.slice(0, STATEMENT_SCAFFOLDS_PER_BATCH * 2).map(({ row }) => ({
    type: 'card' as const,
    id: row.cardId,
    priority: 1,
    conceptId: '',
    conceptName: '',
    interventionReason: 'statement_scaffold' as const,
  }));
  const hydrationData = await loadScheduledItemHydrationData({
    userId: ctx.userId,
    rotationContent: ctx.rotationContent,
    scheduledItems,
    deliveryContext: {
      userId: ctx.userId,
      rotation: ctx.rotation,
      practiceLocale: ctx.practiceLocale,
      weekFilter: null,
      crossSourceRotations: [],
      crossSourceMappingMode: 'adjacent',
    },
  });
  const trust = ctx.imageTier === 'copyright'
    ? 'copyright-required' as const
    : ctx.isGuest ? 'public' as const : 'auth-required' as const;
  const hydrated = await hydrateScheduledItems(scheduledItems, hydrationData, { rotation: ctx.rotation }, null, trust);

  const groups = new Set<string>();
  const verified: UnifiedItem[] = [];
  for (const item of hydrated) {
    if (verified.length >= STATEMENT_SCAFFOLDS_PER_BATCH) break;
    // The tag list may be a minute old: the CURRENT row must still be a
    // scaffold of this module, or it is an ordinary card and stays out.
    if (item.type !== 'card' || item.rotation !== ctx.rotation || !(item.topics ?? []).includes(tag)) continue;
    if (!rowsById.has(item.id)) continue;
    const group = item.variantGroupId;
    if (group && groups.has(group)) continue;
    const violations = checkServedItemContract(item);
    if (violations.length > 0) {
      logger.error('Statement scaffold failed the served-item contract', { cardId: item.id, violations });
      continue;
    }
    if (group) groups.add(group);
    verified.push(item);
  }
  if (verified.length === 0) return [];

  const claims = await Promise.all(verified.map((item) => claimOffer(ctx.userId, rowsById.get(item.id)!, now)));
  const claimed = verified
    .filter((_, index) => claims[index])
    .map((item): UnifiedItem => ({
      ...item,
      interventionReason: 'statement_scaffold',
      decisionContext: {
        servedBy: 'statement-scaffold',
        sessionType: 'review',
        sessionId: ctx.sessionId,
        embeddingType: 'none',
      },
    }));
  if (claimed.length === 0) return [];

  const served = await writeLiveServeDecisions(claimed, {
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    batchId: ctx.batchId,
    rotation: ctx.rotation,
    decisionPath: 'statement-scaffold',
    queueReason: 'statement_scaffold',
  });
  // The progress read above is this delivery's due proof, as the exact-card
  // audit expects of every automatic-feed card exposure.
  const cardDueAudit: CardDueExposureAudit = {
    checkedAt: now,
    nextDueAtByCardId: new Map(progressRows.map((row) => [row.cardId, row.nextDueAt])),
    policyBypassReasonByCardId: new Map(),
    lookupFailed: false,
    version: 'card-due-egress-v1',
  };
  logExposures(served, {
    userId: ctx.userId,
    rotation: ctx.rotation,
    queueType: 'statement-scaffold',
    batchId: ctx.batchId,
    sessionId: ctx.sessionId,
    anonymousSessionId: ctx.anonymousSessionId,
    feedMode: ctx.feedMode,
    cardDueAudit,
  });
  return served;
}

/**
 * Hold an exam-only batch to questions plus this learner's live statement
 * scaffolds. Every other rotation, and any exam-only batch this does not
 * change, is returned as the same response object.
 */
export async function withStatementScaffolds(
  response: NextResponse,
  ctx: SessionContext,
  now: Date = new Date(),
): Promise<NextResponse> {
  const tag = statementScaffoldTag(ctx.rotation);
  if (!tag || response.status !== 200) return response;

  let payload: unknown;
  try {
    // clone() exists on real responses; test doubles may be plain objects.
    payload = await (typeof response.clone === 'function' ? response.clone() : response).json();
  } catch {
    return response;
  }
  if (!isRecord(payload) || !Array.isArray(payload.items)) return response;

  const items = payload.items as unknown[];
  const batch = items.filter((item): item is UnifiedItem => (
    isRecord(item)
    && (item.type === 'question'
      || (item.type === 'card' && isNativeExamScaffold(ctx.rotation, item.topics as string[] | undefined)))
  ));
  const removed = items.length - batch.length;
  if (removed > 0) {
    logger.error('Exam-only batch carried non-question items; removed', {
      rotation: ctx.rotation,
      removed,
      types: [...new Set(items.filter((item) => !batch.includes(item as UnifiedItem))
        .map((item) => (isRecord(item) ? String(item.type) : typeof item)))],
    });
  }

  let scaffolds: UnifiedItem[] = [];
  if (permitsStatementScaffolds(ctx)) {
    try {
      scaffolds = await admitStatementScaffolds(ctx, tag, now);
    } catch (error) {
      logger.warn('Statement scaffolds unavailable; serving the batch without them', {
        rotation: ctx.rotation,
        error: String(error),
      });
    }
  }
  if (removed === 0 && scaffolds.length === 0) return response;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return NextResponse.json({ ...payload, items: [...scaffolds, ...batch] }, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
