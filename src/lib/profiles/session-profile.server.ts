import 'server-only';

/** The public build has no linked profiles: the session is always the account's own. */
export async function applySwitchedProfile<T>(
  payload: T,
  _account: { id: string; email?: string | null; activeProfileUserId?: string | null },
): Promise<T> {
  void _account;
  return payload;
}

export async function clearSwitchedProfile(): Promise<void> {}
