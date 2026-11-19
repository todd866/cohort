/** Small, message-free readings of Prisma errors, for logs and retry decisions. */
/** The Prisma error code (P2028, P2034, ...), never the message, which can carry query detail. */
export function prismaErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : undefined;
}

/** A transaction that could not start in time, or lost a write conflict, is worth one more try. */
export function retryableTransactionError(error: unknown): boolean {
  const code = prismaErrorCode(error);
  return code === 'P2028' || code === 'P2034';
}
