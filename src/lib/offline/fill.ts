export const REFILL_BELOW = 0;
export const REFILL_AFTER_MS = 12 * 60 * 60 * 1000;

export interface FillResult {
  filled: boolean;
  itemCount: number;
  figuresCached: number;
  reason:
    | 'ok'
    | 'offline'
    | 'fresh'
    | 'pending-reviews'
    | 'unauthenticated'
    | 'owner-changed'
    | 'failed';
}

/** Public builds omit the private bulk-pack route, so no refill is scheduled. */
export function needsRefill(
  _pack: { items: unknown[]; savedAt: number } | null,
  _now: number,
): boolean {
  void _pack;
  void _now;
  return false;
}

/** Keep the shared warm-up call safe and explicit without issuing network requests. */
export async function fillOfflinePack(
  userKey: string | null,
  opts: { force?: boolean; size?: number } = {},
): Promise<FillResult> {
  void opts;
  return {
    filled: false,
    itemCount: 0,
    figuresCached: 0,
    reason: userKey ? 'fresh' : 'unauthenticated',
  };
}
