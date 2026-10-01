import type { Adapter } from 'next-auth/adapters';
import { logger } from './logger';

const CONNECTION_TIMEOUT_CODES = new Set(['ETIMEDOUT']);
const CONNECTION_TIMEOUT_MESSAGES = [
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
] as const;

/**
 * Neon/pg can wrap an acquisition timeout in an AggregateError or `cause`.
 * Match only the driver's connection-timeout signatures: a generic query
 * timeout is not safe evidence that the database never executed an operation.
 */
export function isConnectionAcquisitionTimeout(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null || seen.has(current)) continue;
    seen.add(current);

    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (
        typeof record.code === 'string'
        && CONNECTION_TIMEOUT_CODES.has(record.code)
      ) {
        return true;
      }
      const errorMessage = record.message;
      if (
        typeof errorMessage === 'string'
        && CONNECTION_TIMEOUT_MESSAGES.some((message) => errorMessage.includes(message))
      ) {
        return true;
      }
      if (record.cause != null) pending.push(record.cause);
      if (Array.isArray(record.errors)) pending.push(...record.errors);
    }
  }

  return false;
}

/**
 * Retry one explicitly read-only operation after a proven connection-acquire
 * timeout. Callers must not pass mutations: an ambiguous write must never be
 * replayed even though the timeout signatures here normally precede a query.
 */
export async function retryReadAfterConnectionAcquisitionTimeout<T>(
  operation: () => T | PromiseLike<T>,
  logEvent: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isConnectionAcquisitionTimeout(error)) throw error;
    logger.warn(logEvent, {
      reason: 'connection-acquisition-timeout',
    });
    return operation();
  }
}

/**
 * Retry exactly one Auth.js database-session read after a proven connection
 * acquisition timeout. `getSessionAndUser` is the first authenticated DB touch
 * and is read-only in PrismaAdapter. No create/update/delete or arbitrary
 * Prisma operation passes through this wrapper.
 */
export function createSessionLookupRetryAdapter(baseAdapter: Adapter): Adapter {
  const getSessionAndUser = baseAdapter.getSessionAndUser;
  if (!getSessionAndUser) return baseAdapter;

  return {
    ...baseAdapter,
    async getSessionAndUser(sessionToken) {
      return retryReadAfterConnectionAcquisitionTimeout(
        () => getSessionAndUser.call(baseAdapter, sessionToken),
        'auth-session-lookup-retry',
      );
    },
  };
}
