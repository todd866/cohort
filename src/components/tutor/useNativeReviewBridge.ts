'use client';

/** Public builds have no remote review bridge or MCP requests; nothing drives the page. */
export function useNativeReviewBridge(_enabled: boolean): boolean {
  void _enabled;
  return false;
}
