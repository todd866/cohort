import 'server-only';
import type { Session } from 'next-auth';
import { signFigureUrl } from './r2';
import { canView, userTrust } from './trust';
import type { AccessTier } from '@/lib/images/types';
import { pickClientMeta, type ResolvedImage } from './types';
import { lookupSidecar } from '@/lib/figures/server-loader';
import {
  getOriginalFigure,
  ORIGINAL_FIGURE_PREFIX,
  originalFigureManifest,
  originalFigureSidecar,
} from './original-figure-manifest';
import {
  imageKeyIsPromptWithLookup,
  questionImageIsPromptWithLookup,
} from './prompt-policy';

const FIGURES_PREFIX = '/figures/';

/** Canonical original metadata also works in fresh clones before index generation. */
function sidecarForKey(key: string | undefined) {
  if (key?.startsWith(ORIGINAL_FIGURE_PREFIX)) {
    const figure = getOriginalFigure(key);
    return figure && originalFigureManifest
      ? originalFigureSidecar(figure, originalFigureManifest)
      : undefined;
  }
  return lookupSidecar(key);
}

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
  return imageKeyIsPromptWithLookup(imageKey, sidecarForKey);
}

/**
 * A stored prompt assertion is authoritative. Null preserves the historic
 * sidecar inference as a backwards-compatible, fail-closed guard for rows that
 * predate Question.imageRole.
 */
export function questionImageIsPrompt(
  imageRole: string | null | undefined,
  imageKey: string | null | undefined,
): boolean {
  return questionImageIsPromptWithLookup(imageRole, imageKey, sidecarForKey);
}

/**
 * Resolve a stored imageKey to the wire-format payload the API ships.
 *
 * - null/empty key → null.
 * - External URL (anything not starting with /figures/) → passthrough,
 *   no signing, no sidecar metadata.
 * - /figures/ key with missing sidecar → null (safe default).
 * - /figures/ key with sidecar but trust insufficient → null.
 * - Exact reviewed original PNG → app-origin URL with canonical metadata.
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

  const sidecar = sidecarForKey(imageKey);
  if (!sidecar) return null;

  const user = trustOverride ?? userTrust(session);
  if (!canView(sidecar, user)) return null;

  const imageUrl = getOriginalFigure(imageKey)
    ? imageKey
    : await signFigureUrl(toR2Key(imageKey));
  const imageMeta = pickClientMeta(sidecar, imageKey);
  return { imageKey, imageUrl, imageMeta };
}

/**
 * Why `resolveImage` returned null, for LOGS ONLY.
 *
 * The route answers every one of these with an identical 404 body, on purpose:
 * telling a requester whether a figure exists but is above their tier is
 * itself a disclosure. But that means one string covers three different
 * operational problems, and measured on production the delivery route fails
 * about one request in seven — with no way to tell a missing sidecar (a build
 * that shipped without its figure) from an under-tiered viewer (working as
 * designed) from a malformed key.
 *
 * Diagnosing it has required probing signed in with a known-good control key
 * in the same session, because an uncontrolled 404 says nothing. This puts the
 * distinction in the server log instead, where it costs no disclosure and
 * turns a rate into a worklist.
 *
 * Deliberately a separate function rather than a richer return type: the
 * resolver's null is load-bearing at every call site, and widening it would
 * invite a caller to branch on the reason and leak it.
 */
export type ResolveFailureReason =
  | 'no-key'
  | 'not-a-figure-key'
  | 'missing-sidecar'
  | 'insufficient-tier'
  /**
   * Every check passed, so the image should have resolved. Seeing this in a log
   * means the resolver and this classifier disagreed — a signing failure, or
   * the sidecar index changing between the two calls. Named rather than folded
   * into another reason, because a wrong reason in a log is worse than none.
   */
  | 'resolved-after-all';

export function resolveImageFailureReason(
  imageKey: string | null,
  session: Session | null,
  trustOverride?: AccessTier,
): ResolveFailureReason {
  if (!imageKey) return 'no-key';
  if (!imageKey.startsWith(FIGURES_PREFIX)) return 'not-a-figure-key';
  const sidecar = sidecarForKey(imageKey);
  if (!sidecar) return 'missing-sidecar';
  const user = trustOverride ?? userTrust(session);
  if (!canView(sidecar, user)) return 'insufficient-tier';
  return 'resolved-after-all';
}
