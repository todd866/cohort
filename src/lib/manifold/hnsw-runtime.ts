import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const HNSW_ITERATIVE_SCAN = 'strict_order' as const;
export const HNSW_EF_SEARCH = 1_000;
export const HNSW_MAX_SCAN_TUPLES = 50_000;
export const HNSW_SCAN_MEM_MULTIPLIER = 2;
export const HNSW_TRANSACTION_MAX_WAIT_MS = 10_000;
export const HNSW_TRANSACTION_TIMEOUT_MS = 120_000;

type HnswTransaction = Pick<Prisma.TransactionClient, '$executeRawUnsafe' | '$queryRaw'>;

type HnswTransactionHost = Readonly<{
  $transaction<T>(
    operation: (transaction: HnswTransaction) => Promise<T>,
    options: Readonly<{ maxWait: number; timeout: number }>,
  ): Promise<T>;
}>;

/**
 * Execute one ANN query with the production pgvector settings on the exact same physical
 * connection. Role defaults do not update already-warm PgBouncer backends;
 * SET LOCAL inside an interactive transaction does and is reset on commit.
 */
export async function withHnswRuntime<T>(
  operation: (transaction: HnswTransaction) => Promise<T>,
  host: HnswTransactionHost = prisma as unknown as HnswTransactionHost,
): Promise<T> {
  return host.$transaction(
    async (transaction) => {
      await transaction.$executeRawUnsafe(
        `SET LOCAL hnsw.iterative_scan = '${HNSW_ITERATIVE_SCAN}'`,
      );
      await transaction.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`);
      await transaction.$executeRawUnsafe(
        `SET LOCAL hnsw.max_scan_tuples = ${HNSW_MAX_SCAN_TUPLES}`,
      );
      await transaction.$executeRawUnsafe(
        `SET LOCAL hnsw.scan_mem_multiplier = ${HNSW_SCAN_MEM_MULTIPLIER}`,
      );
      return operation(transaction);
    },
    {
      maxWait: HNSW_TRANSACTION_MAX_WAIT_MS,
      timeout: HNSW_TRANSACTION_TIMEOUT_MS,
    },
  );
}
