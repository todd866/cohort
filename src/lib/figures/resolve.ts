import 'server-only';
import type { Session } from 'next-auth';
import { signFigureUrl } from './r2';
import { canView, userTrust } from './trust';
import type { AccessTier } from '@/lib/images/types';
import { pickClientMeta, type ResolvedImage } from './types';
import { lookupSidecar } from '@/lib/figures/server-loader';

const FIGURES_PREFIX = '/figures/';

/** Strip the /figures/ prefix to get the R2 object key. */
function toR2Key(imageKey: string): string {
  return imageKey.slice(FIGURES_PREFIX.length);
}

/**
 * A diagnostic figure shown before reveal is the question prompt, not optional
 * teaching decoration. Any question carrying one is unanswerable when the
 * viewer cannot resolve that image, so server delivery paths must drop it.
 */
export function imageKeyIsPrompt(imageKey: string | null | undefined): boolean {
  if (!imageKey?.startsWith(FIGURES_PREFIX)) return false;
  const sidecar = lookupSidecar(imageKey);
  // Internal figure keys that are absent from the generated sidecar index are
  // unresolved by resolveImage(). Treat them as prompt content so every
  // question-delivery guard fails closed instead of serving an unanswerable
  // image-dependent question. External URLs remain outside this policy.
  if (!sidecar) return true;
  return sidecar.class === 'diagnostic' && sidecar.showWhen !== 'after-reveal';
}

/**
 * Resolve a stored imageKey to the wire-format payload the API ships.
 *
 * - null/empty key → null.
 * - External URL (anything not starting with /figures/) → passthrough,
 *   no signing, no sidecar metadata.
 * - /figures/ key with missing sidecar → null (safe default).
 * - /figures/ key with sidecar but trust insufficient → null.
 * - /figures/ key with sidecar + sufficient trust → signed R2 URL.
 */
export async function resolveImage(
  imageKey: string | null,
  session: Session | null,
  /**
   * Explicit access tier, for server paths that have an authenticated userId
   * but no Session object.
   *
   * The offline-pack and cache-refresh lanes call hydration with session=null,
   * so `userTrust(null)` returned 'public' and every auth- or copyright-gated
   * figure resolved to null, so offline packs could cache zero figures. Callers
   * pass the imageTier they already read from the DB for
   * the authenticated user — authoritative, and never client-supplied.
   */
  trustOverride?: AccessTier,
): Promise<ResolvedImage | null> {
  if (!imageKey) return null;

  if (!imageKey.startsWith(FIGURES_PREFIX)) {
    return { imageKey, imageUrl: imageKey, imageMeta: undefined };
  }

  const sidecar = lookupSidecar(imageKey);
  if (!sidecar) return null;

  const user = trustOverride ?? userTrust(session);
  if (!canView(sidecar, user)) return null;

  const imageUrl = await signFigureUrl(toR2Key(imageKey));
  const imageMeta = pickClientMeta(sidecar);
  return { imageKey, imageUrl, imageMeta };
}
