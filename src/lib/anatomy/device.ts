/**
 * Get device type from user agent or screen width.
 * Client-safe — no server dependencies.
 */
export function getDeviceType(
  userAgent?: string,
  screenWidth?: number
): 'mobile' | 'tablet' | 'desktop' {
  if (screenWidth) {
    if (screenWidth < 768) return 'mobile';
    if (screenWidth < 1024) return 'tablet';
    return 'desktop';
  }

  if (userAgent) {
    const ua = userAgent.toLowerCase();
    if (/mobile|iphone|android.*mobile/.test(ua)) return 'mobile';
    if (/tablet|ipad|android(?!.*mobile)/.test(ua)) return 'tablet';
  }

  return 'desktop';
}
