import 'server-only';

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  buildRequestFingerprint,
  isRetryableReviewTransactionError,
  REVIEW_TRANSACTION_MAX_ATTEMPTS,
  SERIALIZABLE_REVIEW_TRANSACTION,
} from '@/lib/idempotency';
import { loadPublicUsmleQuestionCorpus } from './public-question-corpus.server';
import {
  createStep1Session,
  replayStep1Session,
  Step1ApiError,
  type Step1DeliveryRow,
  type Step1SessionReceipt,
} from './step1-session.server';
import type { Step1SessionMode, Step1SessionResult } from './step1-contract';

export interface Step1SessionRequest {
  serveRequestId: string;
  mode: Step1SessionMode;
  size: number;
  domains?: string[];
}
const RECEIPT_CONTRACT = 'step1-session-receipt-v1';
const OPERATION = 'step1_serve';

function parseReceipt(value: unknown): Step1SessionReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !== 'contract,deliveryIds,mode,requestedSize,sessionId'
    || row.contract !== RECEIPT_CONTRACT
    || typeof row.sessionId !== 'string' || !row.sessionId
    || (row.mode !== 'daily' && row.mode !== 'baseline')
    || typeof row.requestedSize !== 'number' || !Number.isSafeInteger(row.requestedSize)
    || row.requestedSize < 1 || row.requestedSize > 20
    || !Array.isArray(row.deliveryIds) || row.deliveryIds.length < 1
    || row.deliveryIds.length > row.requestedSize
    || row.deliveryIds.some(id => typeof id !== 'string' || !id)
    || new Set(row.deliveryIds).size !== row.deliveryIds.length
  ) return null;
  return { sessionId: row.sessionId, mode: row.mode, requestedSize: row.requestedSize, deliveryIds: row.deliveryIds };
}

/** Selection, delivery proofs and replay identity commit or roll back together. */
export async function issueStep1Session(
  input: Step1SessionRequest & { userId: string },
): Promise<Step1SessionResult> {
  const domains = [...new Set(input.domains ?? [])].sort();
  const fingerprint = buildRequestFingerprint(OPERATION, 'usmle-step1', {
    mode: input.mode, size: input.size, domains,
  });
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async rawTx => {
        const tx = rawTx as unknown as Prisma.TransactionClient;
        const existing = await tx.syncOperation.findUnique({
          where: { userId_clientOperationId: { userId: input.userId, clientOperationId: input.serveRequestId } },
          select: { operationType: true, requestFingerprint: true, status: true, result: true },
        });
        if (existing) {
          if (existing.operationType !== OPERATION || existing.requestFingerprint !== fingerprint) {
            throw new Step1ApiError(409, 'serve_request_conflict', 'Session request ID was already used for a different request');
          }
          const receipt = existing.status === 'completed' ? parseReceipt(existing.result) : null;
          if (!receipt || receipt.mode !== input.mode || receipt.requestedSize !== input.size) {
            throw new Step1ApiError(503, 'serve_receipt_unavailable', 'Saved session is unavailable; please retry');
          }
          const deliveries = await tx.serveDecision.findMany({
            where: {
              id: { in: receipt.deliveryIds }, userId: input.userId, sessionId: receipt.sessionId,
              itemType: 'question', deliveryPath: 'live',
              decisionPath: { in: ['usmle-step1-baseline-v1', 'usmle-step1-daily-v1'] },
            },
            select: { id: true, itemId: true, sessionId: true, payload: true },
          });
          const corpus = await loadPublicUsmleQuestionCorpus(rawTx);
          return replayStep1Session(receipt, deliveries, corpus);
        }

        let deliveryRows: Step1DeliveryRow[] = [];
        const created = await createStep1Session({
          userId: input.userId, mode: input.mode, size: input.size, domains,
        }, {
          loadCorpus: () => loadPublicUsmleQuestionCorpus(rawTx),
          loadHistory: (userId, questionIds) => tx.questionResponse.findMany({
            where: { userId, questionId: { in: questionIds } },
            select: { questionId: true, isCorrect: true, createdAt: true, sessionType: true },
            orderBy: { createdAt: 'asc' },
          }),
          // Buffer inside this transaction so raw write conflicts reach the
          // retry loop; createStep1Session sanitizes persistence exceptions.
          persistDeliveries: async rows => { deliveryRows = rows; return rows.length; },
        });
        const written = await tx.serveDecision.createMany({ data: deliveryRows });
        if (written.count !== deliveryRows.length || deliveryRows.length === 0) {
          throw new Step1ApiError(503, 'delivery_persistence_failed', 'Could not safely record this session; please retry');
        }
        const receipt = {
          contract: RECEIPT_CONTRACT,
          sessionId: created.sessionId, mode: created.mode, requestedSize: created.requestedSize,
          deliveryIds: created.items.map(item => item.deliveryId),
        };
        await tx.syncOperation.create({ data: {
          userId: input.userId, clientOperationId: input.serveRequestId, operationType: OPERATION,
          status: 'completed', requestFingerprint: fingerprint, result: receipt,
        } });
        return {
          sessionId: created.sessionId, mode: created.mode,
          requestedSize: created.requestedSize, deliveredSize: created.deliveredSize, items: created.items,
        };
      }, SERIALIZABLE_REVIEW_TRANSACTION);
    } catch (error) {
      if (error instanceof Step1ApiError || !isRetryableReviewTransactionError(error)) throw error;
      if (attempt >= REVIEW_TRANSACTION_MAX_ATTEMPTS) {
        throw new Step1ApiError(503, 'session_unavailable', 'Could not safely record this session; please retry');
      }
    }
  }
}
