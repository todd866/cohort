const CALLBACK_BASE = 'https://md3.invalid';

/**
 * Accept only an origin-relative path. This preserves review query intent
 * without allowing the sign-in surface to become an open redirect.
 */
export function safeInternalCallback(
  raw: string | null | undefined,
  fallback = '/',
): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return fallback;

  try {
    const parsed = new URL(raw, CALLBACK_BASE);
    if (parsed.origin !== CALLBACK_BASE) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
