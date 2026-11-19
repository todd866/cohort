/** Public builds have no paid embedding provider or billing ledger. */
export async function createMeteredContentLakeEmbedding(_input: unknown): Promise<{ data: Array<{ embedding: number[] }> }> {
  return { data: [] };
}
