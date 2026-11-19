/** Private object storage is absent; never claim that nonempty object deletion succeeded. */
export async function deleteR2Objects(keys: readonly string[]): Promise<void> {
  if (keys.length > 0) throw new Error('Object storage is unavailable in this distribution.');
}
