export const REVIEW_BOOTSTRAP_SAFETY_COOKIE = 'md3_review_bootstrap_safe';
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function parseReviewBootstrapSafetyOwner(
  value: string | null | undefined,
): string | null {
  if (!value?.endsWith(':clean')) return null;
  try {
    const ownerKey = decodeURIComponent(value.slice(0, -':clean'.length));
    return ownerKey.trim().length > 0 ? ownerKey : null;
  } catch {
    return null;
  }
}

export function markReviewBootstrapClean(ownerKey: string): void {
  if (typeof document === 'undefined' || !ownerKey) return;
  document.cookie = [
    `${REVIEW_BOOTSTRAP_SAFETY_COOKIE}=${encodeURIComponent(ownerKey)}:clean`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ].join('; ');
}

export function markReviewBootstrapDirty(ownerKey?: string | null): void {
  if (typeof document === 'undefined') return;
  // Owner is intentionally retained in the dirty value for diagnostics, but
  // the server parser accepts only the explicit :clean state.
  const value = ownerKey ? `${encodeURIComponent(ownerKey)}:dirty` : 'dirty';
  document.cookie = [
    `${REVIEW_BOOTSTRAP_SAFETY_COOKIE}=${value}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ].join('; ');
}

export function clearReviewBootstrapSafety(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${REVIEW_BOOTSTRAP_SAFETY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
