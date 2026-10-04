import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const HNSW_ITERATIVE_SCAN = 'strict_order' as const;
export const HNSW_EF_SEARCH = 1_000;
export const HNSW_MAX_SCAN_TUPLES = 50_000;
export const HNSW_SCAN_MEM_MULTIPLIER = 2;
export const HNSW_TRANSACTION_MAX_WAIT_MS = 10_000;
export const HNSW_TRANSACTION_TIMEOUT_MS = 120_000;
/** pgvector's accepted range for hnsw.ef_search. */
const HNSW_EF_SEARCH_MIN = 1;
const HNSW_EF_SEARCH_MAX = 1_000;

type HnswTransaction = Pick<Prisma.TransactionClient, '$executeRawUnsafe' | '$queryRaw'>;

type HnswTransactionHost = Readonly<{
  $transaction<T>(
    operation: (transaction: HnswTransaction) => Promise<T>,
    options: Readonly<{ maxWait: number; timeout: number }>,
  ): Promise<T>;
}>;

export type HnswRuntimeOptions = Readonly<{
  /**
   * Candidate-list size for this query only. The shared default suits searches that filter
   * inside the scan; an unfiltered nearest-neighbour query needs only about its LIMIT.
   */
  efSearch?: number;
}>;

/**
 * Execute one ANN query with the production pgvector settings on the exact same physical
 * connection. Role defaults do not update already-warm PgBouncer backends;
 * SET LOCAL inside an interactive transaction does and is reset on commit.
 */
export async function withHnswRuntime<T>(
  operation: (transaction: HnswTransaction) => Promise<T>,
  host: HnswTransactionHost = prisma as unknown as HnswTransactionHost,
  options: HnswRuntimeOptions = {},
): Promise<T> {
  const efSearch = options.efSearch ?? HNSW_EF_SEARCH;
  // Interpolated into SET LOCAL below, so it must be a plain in-range integer, and a bad value
  // should fail before a pooled connection is taken.
  if (!Number.isInteger(efSearch) || efSearch < HNSW_EF_SEARCH_MIN || efSearch > HNSW_EF_SEARCH_MAX) {
    throw new RangeError(
      `hnsw.ef_search must be an integer from ${HNSW_EF_SEARCH_MIN} to ${HNSW_EF_SEARCH_MAX}; got ${efSearch}`,
    );
  }
  return host.$transaction(
    async (transaction) => {
      await transaction.$executeRawUnsafe(
        `SET LOCAL hnsw.iterative_scan = '${HNSW_ITERATIVE_SCAN}'`,
      );
      await transaction.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${efSearch}`);
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
