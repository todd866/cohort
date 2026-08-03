import type { UnifiedItem } from './unified-session-types';

/** The fields of the SOURCE record (content map row) a lane started from. */
export type ContractSource = {
  imageUrl: string | null;
  imageRole: string | null;
};

/**
 * The invariant every serve lane must satisfy. It was written down in
 * unified-session-types.ts as a comment ("Required when imageUrl is set — the
 * harness rule") and enforced nowhere; on 2026-07-09 two of six lanes violated
 * it in production.
 *
 * Returns human-readable violations; empty array means conforming.
 */
export function checkServedItemContract(item: UnifiedItem, source?: ContractSource): string[] {
  const violations: string[] = [];

  if (item.imageUrl) {
    if (!item.imageCaption?.trim()) {
      violations.push('imageUrl set but imageCaption missing');
    }
    if (!item.imageKey) {
      violations.push('imageUrl set but imageKey missing (not resolved)');
    }
    // resolveImage returns a signed R2 URL (or an external passthrough). A bare
    // /figures/ key means the lane skipped resolveImage; the browser gets a 404.
    if (item.imageUrl.startsWith('/figures/')) {
      violations.push('imageUrl is a raw /figures/ key, not a signed URL');
    }
  }

  if (source?.imageRole === 'prompt' && !item.imageUrl) {
    violations.push('source card is imageRole=prompt but served item has no imageUrl');
  }

  return violations;
}
