/** Public builds have no recording objects; ordinary guest cleanup remains guarded. */
export async function deleteVoiceRecordingPrefix(_db: unknown, _userId: string, _deleteObjects: unknown): Promise<number> {
  return 0;
}
export async function purgeGuestUsers(
  db: { user: { deleteMany(args: { where: { id: string; email: null; name: 'Guest' } }): Promise<{ count: number }> } },
  ids: readonly string[],
  _deleteObjects: unknown,
): Promise<number> {
  let removed = 0;
  for (const id of ids) {
    const result = await db.user.deleteMany({ where: { id, email: null, name: 'Guest' } });
    removed += result.count;
  }
  return removed;
}

/** Public builds have no paid tutor usage to transfer. */
export async function lockGuestUsageClaim(_tx: unknown): Promise<void> {}
export async function claimGuestOpenAiUsage(_tx: unknown, _guestUserId: string, _userId: string): Promise<void> {}
export async function hasUnresolvedGuestVoiceOwnership(_tx: unknown, _userId: string): Promise<boolean> { return false; }
