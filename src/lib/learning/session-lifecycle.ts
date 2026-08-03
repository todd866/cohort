import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  createPreparedLearningEvent,
  prepareLearningEvent,
  type LearningEventType,
  type PreparedLearningEvent,
} from '@/lib/learning/record-event';
import {
  isPrismaErrorCode,
  SERIALIZABLE_REVIEW_TRANSACTION,
} from '@/lib/idempotency';

export type SessionLifecycleEventType = Extract<
  LearningEventType,
  'session_started' | 'session_ended' | 'target_crossed'
>;

export interface RecordSessionLifecycleEventInput {
  userId: string;
  sessionId: string;
  eventType: SessionLifecycleEventType;
  rotation?: string;
  metadata?: Record<string, unknown>;
  timestamp?: Date;
}

export interface RecordSessionLifecycleEventResult {
  eventId: string;
  deduped: boolean;
  /** True only when this request repaired a missing start. */
  recoveredStart: boolean;
}

const OPERATION_TYPE = 'session_lifecycle';
const MAX_TRANSACTION_ATTEMPTS = 4;
const MAX_RECOVERED_DURATION_MS = 24 * 60 * 60 * 1000;

interface LifecycleClient {
  learningEvent: {
    findFirst(args: {
      where: { userId: string; sourceType: string; sourceId: string; eventType: string };
      select: { id: true };
      orderBy: { timestamp: 'asc' };
    }): PromiseLike<{ id: string } | null>;
  };
  syncOperation: {
    findUnique(args: {
      where: { userId_clientOperationId: { userId: string; clientOperationId: string } };
      select: { operationType: true; status: true; result: true };
    }): PromiseLike<{ operationType: string; status: string; result: Prisma.JsonValue | null } | null>;
    create(args: {
      data: {
        userId: string;
        clientOperationId: string;
        operationType: string;
        status: string;
        requestFingerprint: string;
        result: { eventId: string };
      };
    }): PromiseLike<unknown>;
  };
}

function receiptKey(sessionId: string, eventType: SessionLifecycleEventType): string {
  return `session-lifecycle:${sessionId}:${eventType}`;
}

function resultEventId(result: Prisma.JsonValue | null): string | null {
  if (!result || Array.isArray(result) || typeof result !== 'object') return null;
  const eventId = (result as Record<string, Prisma.JsonValue>).eventId;
  return typeof eventId === 'string' ? eventId : null;
}

async function findLifecycleEvent(
  client: LifecycleClient,
  input: Pick<RecordSessionLifecycleEventInput, 'userId' | 'sessionId' | 'eventType'>,
): Promise<{ id: string } | null> {
  return client.learningEvent.findFirst({
    where: {
      userId: input.userId,
      sourceType: 'session',
      sourceId: input.sessionId,
      eventType: input.eventType,
    },
    select: { id: true },
    orderBy: { timestamp: 'asc' },
  });
}

async function readReceipt(
  client: LifecycleClient,
  input: Pick<RecordSessionLifecycleEventInput, 'userId' | 'sessionId' | 'eventType'>,
): Promise<{ eventId: string } | null> {
  const receipt = await client.syncOperation.findUnique({
    where: {
      userId_clientOperationId: {
        userId: input.userId,
        clientOperationId: receiptKey(input.sessionId, input.eventType),
      },
    },
    select: { operationType: true, status: true, result: true },
  });
  if (!receipt) return null;
  if (receipt.operationType !== OPERATION_TYPE || receipt.status !== 'completed') {
    throw new Error('Lifecycle idempotency receipt is invalid');
  }

  const eventId = resultEventId(receipt.result);
  if (eventId) return { eventId };
  const event = await findLifecycleEvent(client, input);
  if (!event) throw new Error('Lifecycle receipt exists without its event');
  return { eventId: event.id };
}

async function writeReceipt(
  client: LifecycleClient,
  input: Pick<RecordSessionLifecycleEventInput, 'userId' | 'sessionId' | 'eventType'>,
  eventId: string,
): Promise<void> {
  await client.syncOperation.create({
    data: {
      userId: input.userId,
      clientOperationId: receiptKey(input.sessionId, input.eventType),
      operationType: OPERATION_TYPE,
      status: 'completed',
      requestFingerprint: receiptKey(input.sessionId, input.eventType),
      result: { eventId },
    },
  });
}

function recoveredStartTimestamp(input: RecordSessionLifecycleEventInput): Date {
  const rawDuration = input.metadata?.durationMs;
  const durationMs = typeof rawDuration === 'number' && Number.isFinite(rawDuration)
    ? Math.max(0, Math.min(MAX_RECOVERED_DURATION_MS, rawDuration))
    : 0;
  const eventTime = input.timestamp ?? new Date();
  return new Date(eventTime.getTime() - durationMs);
}

async function prepare(
  input: RecordSessionLifecycleEventInput,
  eventType: SessionLifecycleEventType = input.eventType,
): Promise<PreparedLearningEvent> {
  const recovered = eventType === 'session_started' && input.eventType !== 'session_started';
  return prepareLearningEvent({
    userId: input.userId,
    eventType,
    sourceType: 'session',
    sourceId: input.sessionId,
    rotation: input.rotation,
    metadata: recovered
      ? { recovered: true, recoveredFromEvent: input.eventType }
      : input.metadata,
    timestamp: recovered ? recoveredStartTimestamp(input) : input.timestamp,
  });
}

/**
 * Record one lifecycle transition with a database-backed idempotency receipt.
 * End/target writes repair a missing start because beacon/fetch delivery can
 * legitimately arrive out of order during rapid page teardown.
 */
export async function recordSessionLifecycleEvent(
  input: RecordSessionLifecycleEventInput,
): Promise<RecordSessionLifecycleEventResult> {
  const requested = await prepare(input);
  const recoveredStart = input.eventType === 'session_started'
    ? null
    : await prepare(input, 'session_started');
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const existingReceipt = await readReceipt(tx, input);
        if (existingReceipt) {
          return {
            eventId: existingReceipt.eventId,
            deduped: true,
            recoveredStart: false,
          };
        }

        let didRecoverStart = false;
        if (recoveredStart) {
          const startInput = { ...input, eventType: 'session_started' as const };
          const startReceipt = await readReceipt(tx, startInput);
          if (!startReceipt) {
            const historicalStart = await findLifecycleEvent(tx, startInput);
            if (historicalStart) {
              await writeReceipt(tx, startInput, historicalStart.id);
            } else {
              const start = await createPreparedLearningEvent(tx, recoveredStart);
              await writeReceipt(tx, startInput, start.id);
              didRecoverStart = true;
            }
          }
        }

        // Backfill a receipt around pre-rollout rows instead of duplicating them.
        const historicalEvent = await findLifecycleEvent(tx, input);
        if (historicalEvent) {
          await writeReceipt(tx, input, historicalEvent.id);
          return {
            eventId: historicalEvent.id,
            deduped: true,
            recoveredStart: didRecoverStart,
          };
        }

        const event = await createPreparedLearningEvent(tx, requested);
        await writeReceipt(tx, input, event.id);
        return { eventId: event.id, deduped: false, recoveredStart: didRecoverStart };
      }, SERIALIZABLE_REVIEW_TRANSACTION);
    } catch (error) {
      lastError = error;
      if (!isPrismaErrorCode(error, 'P2002') && !isPrismaErrorCode(error, 'P2034')) {
        throw error;
      }

      // A concurrent copy may have won the receipt race. If the desired
      // receipt is now committed, acknowledge the replay; otherwise retry
      // (the collision may have been on the recovered-start receipt).
      const existingReceipt = await readReceipt(prisma, input);
      if (existingReceipt) {
        return {
          eventId: existingReceipt.eventId,
          deduped: true,
          recoveredStart: false,
        };
      }
    }
  }

  throw lastError ?? new Error('Failed to record session lifecycle event');
}
