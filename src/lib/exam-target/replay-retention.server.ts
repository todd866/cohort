import 'server-only';

import { Prisma } from '@prisma/client';

export const EXAM_TARGET_REPLAY_PRUNE_BATCH_SIZE_DEFAULT = 500;
export const EXAM_TARGET_REPLAY_PRUNE_BATCHES_DEFAULT = 20;
export const MAX_EXAM_TARGET_REPLAY_PRUNE_BATCH_SIZE = 5_000;
export const MAX_EXAM_TARGET_REPLAY_PRUNE_BATCHES = 200;

export type ExamTargetReplayPruneMode = 'dry-run' | 'apply';

interface ReplayExpiryWhere {
  replayExpiresAt: { lte: Date };
}

export interface ExamTargetReplayRetentionClient {
  schedulerDecisionSet: {
    count(args: { where: ReplayExpiryWhere }): Promise<number>;
    findMany(args: {
      where: ReplayExpiryWhere;
      select: { id: true };
      orderBy: [{ replayExpiresAt: 'asc' }, { id: 'asc' }];
      take: number;
    }): Promise<Array<{ id: string }>>;
    updateMany(args: {
      where: {
        id: { in: string[] };
        replayExpiresAt: { lte: Date };
      };
      data: {
        replaySnapshot: unknown;
        replayCapturedAt: null;
        replayExpiresAt: null;
      };
    }): Promise<{ count: number }>;
  };
}

export interface ExamTargetReplayPruneOptions {
  /** Defaults to dry-run. Mutation always requires the explicit apply mode. */
  mode?: ExamTargetReplayPruneMode;
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}

export interface ExamTargetReplayPruneResult {
  mode: ExamTargetReplayPruneMode;
  asOf: Date;
  eligible: number;
  cleared: number;
  batches: number;
  batchSize: number;
  maxBatches: number;
  maxRows: number;
  cappedOut: boolean;
}

function boundedPositiveInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function nonnegativeCount(value: number, label: string, maximum?: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || (maximum !== undefined && value > maximum)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

/**
 * Clears only sampled replay bodies whose explicit retention deadline has
 * passed. Aggregate SchedulerDecisionSet metrics and the row itself remain.
 *
 * The database constraint treats replaySnapshot/replayCapturedAt/
 * replayExpiresAt as one nullable group, so all three are nulled together.
 * Work is selected and updated in bounded batches, and the update repeats the
 * expiry predicate so a concurrent retention extension cannot be erased.
 */
export async function pruneExpiredExamTargetReplays(
  client: ExamTargetReplayRetentionClient,
  options: ExamTargetReplayPruneOptions = {},
): Promise<ExamTargetReplayPruneResult> {
  const mode = options.mode ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new TypeError('exam-target replay prune mode must be dry-run or apply');
  }
  const asOf = options.now === undefined
    ? new Date()
    : new Date(options.now.getTime());
  if (!Number.isFinite(asOf.getTime())) {
    throw new TypeError('exam-target replay prune timestamp is invalid');
  }
  const batchSize = boundedPositiveInteger(
    options.batchSize ?? EXAM_TARGET_REPLAY_PRUNE_BATCH_SIZE_DEFAULT,
    'exam-target replay prune batchSize',
    MAX_EXAM_TARGET_REPLAY_PRUNE_BATCH_SIZE,
  );
  const maxBatches = boundedPositiveInteger(
    options.maxBatches ?? EXAM_TARGET_REPLAY_PRUNE_BATCHES_DEFAULT,
    'exam-target replay prune maxBatches',
    MAX_EXAM_TARGET_REPLAY_PRUNE_BATCHES,
  );
  const maxRows = batchSize * maxBatches;
  const where: ReplayExpiryWhere = { replayExpiresAt: { lte: asOf } };
  const eligible = nonnegativeCount(
    await client.schedulerDecisionSet.count({ where }),
    'eligible replay count',
  );

  if (mode === 'dry-run') {
    return {
      mode,
      asOf,
      eligible,
      cleared: 0,
      batches: 0,
      batchSize,
      maxBatches,
      maxRows,
      cappedOut: eligible > maxRows,
    };
  }

  let cleared = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const rows = await client.schedulerDecisionSet.findMany({
      where,
      select: { id: true },
      orderBy: [{ replayExpiresAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });
    if (rows.length === 0) break;
    if (rows.length > batchSize) {
      throw new TypeError('exam-target replay prune delegate exceeded its batch limit');
    }
    const ids = rows.map(({ id }) => id);
    if (
      ids.some((id) => typeof id !== 'string' || id.length === 0)
      || new Set(ids).size !== ids.length
    ) {
      throw new TypeError('exam-target replay prune received invalid decision ids');
    }

    const mutation = await client.schedulerDecisionSet.updateMany({
      where: {
        id: { in: ids },
        replayExpiresAt: { lte: asOf },
      },
      data: {
        // Prisma.DbNull maps the nullable Json column to SQL NULL; plain null
        // would represent JSON null and violate the three-field DB constraint.
        replaySnapshot: Prisma.DbNull,
        replayCapturedAt: null,
        replayExpiresAt: null,
      },
    });
    cleared += nonnegativeCount(mutation.count, 'cleared replay count', rows.length);
    batches += 1;
  }

  const cappedOut = batches >= maxBatches
    && (await client.schedulerDecisionSet.findMany({
      where,
      select: { id: true },
      orderBy: [{ replayExpiresAt: 'asc' }, { id: 'asc' }],
      take: 1,
    })).length > 0;

  return {
    mode,
    asOf,
    eligible,
    cleared,
    batches,
    batchSize,
    maxBatches,
    maxRows,
    cappedOut,
  };
}
