import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const CLIENT_REQUEST_ID_MAX_LENGTH = 128;
export const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Bundles built before the idempotency rollout omit clientRequestId, and a
 * browser keeps running one until it reloads. Rejecting those writes loses the
 * grade; minting a per-request id instead preserves their pre-rollout
 * behaviour (no deduplication) while newer clients still get replay safety.
 * Every call returns a fresh id, so a replay is never mistaken for a duplicate.
 */
export function legacyClientRequestId(): string {
  return `legacy-${randomUUID()}`;
}
export const REVIEW_TRANSACTION_MAX_ATTEMPTS = 4;
export type ReviewOperationType =
  | 'card_review'
  | 'mcq_response'
  | 'group_attempt'
  | 'assessment_attempt'
  | 'video_watch';

type JsonScalar = string | number | boolean | null;
type FingerprintValue = JsonScalar | FingerprintValue[] | { [key: string]: FingerprintValue };

function stableValue(value: FingerprintValue): FingerprintValue {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

/** Hash only the semantic fields that must be identical on a replay. */
export function buildRequestFingerprint(
  operationType: ReviewOperationType,
  resourceId: string,
  payload: FingerprintValue,
): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue({ operationType, resourceId, payload })))
    .digest('hex');
}

export function isPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === code
  ) || (
    error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === code
  );
}

export function isRetryableReviewTransactionError(error: unknown): boolean {
  // P2034 = write conflict/deadlock. P2002 can be the attempt-number authority
  // rejecting a concurrent max+1 allocation; callers first check whether the
  // idempotency marker exists before treating P2002 as allocational.
  return isPrismaErrorCode(error, 'P2034') || isPrismaErrorCode(error, 'P2002');
}

export type OperationReplay<T> =
  | { kind: 'none' }
  | { kind: 'completed'; result: T | null }
  | { kind: 'conflict' }
  | { kind: 'incomplete' };

/**
 * Read a transactionally completed receipt after a unique-key collision.
 * A payload/key mismatch is a client bug and must never be acknowledged as a
 * duplicate of a different grade.
 */
export async function readOperationReplay<T>(input: {
  userId: string;
  clientRequestId: string;
  operationType: ReviewOperationType;
  requestFingerprint: string;
}): Promise<OperationReplay<T>> {
  const operation = await prisma.syncOperation.findUnique({
    where: {
      userId_clientOperationId: {
        userId: input.userId,
        clientOperationId: input.clientRequestId,
      },
    },
    select: {
      operationType: true,
      status: true,
      requestFingerprint: true,
      result: true,
    },
  });

  if (!operation) return { kind: 'none' };
  if (operation.operationType !== input.operationType) return { kind: 'conflict' };
  // Historical markers without a fingerprint/receipt cannot prove which
  // payload committed (or whether a pre-migration side effect committed at
  // all). Never acknowledge them as a successful replay.
  if (!operation.requestFingerprint || operation.requestFingerprint !== input.requestFingerprint) {
    return { kind: 'conflict' };
  }
  if (operation.status !== 'completed') return { kind: 'incomplete' };
  return { kind: 'completed', result: operation.result as T | null };
}

export const SERIALIZABLE_REVIEW_TRANSACTION = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;
