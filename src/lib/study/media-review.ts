import { publicClipWhere } from '@/lib/video/public-clips';
import type { ReviewMedia } from '@/lib/review/review-intent';
import type { AccessTier } from '@/lib/images/types';
import { lookupServingSidecar, servingFigureKeys } from '@/lib/figures/serving-index';
import { canView } from '@/lib/figures/trust';
import { isWithdrawnFigure } from '@/lib/figures/withdrawn-figures';
import { getOriginalFigure, ORIGINAL_FIGURE_PREFIX, originalFigureManifest } from '@/lib/figures/original-figure-manifest';

const visibleFigures = new Map<AccessTier, { keys: string[]; set: ReadonlySet<string> }>();

/** Built once per trust tier/isolate from the resolver's serving projection. */
function visibleFigureKeys(trust: AccessTier) {
  let visible = visibleFigures.get(trust);
  if (!visible) {
    const allKeys = new Set([...servingFigureKeys(), ...(originalFigureManifest?.figures ?? [])
      .map(figure => `${ORIGINAL_FIGURE_PREFIX}${figure.id}.png`)]);
    const keys = [...allKeys].filter(key => {
      if (isWithdrawnFigure(key)) return false;
      // Originals use the reviewed manifest, even if an older index lists them.
      if (key.startsWith(ORIGINAL_FIGURE_PREFIX)) return Boolean(getOriginalFigure(key));
      const sidecar = lookupServingSidecar(key);
      return Boolean(sidecar && canView(sidecar, trust));
    });
    visible = { keys, set: new Set(keys) };
    visibleFigures.set(trust, visible);
  }
  return visible;
}

export function matchesCandidateImage(imageUrl: string | null | undefined, trust: AccessTier): boolean {
  if (!imageUrl?.trim() || isWithdrawnFigure(imageUrl)) return false;
  return !imageUrl.startsWith('/figures/') || visibleFigureKeys(trust).set.has(imageUrl);
}

/** Candidate predicate shared by Card and Question. Image access is proved by
 * the existing resolver at egress, never by the presence of a stored key. */
export function mediaCandidateWhere(
  media?: ReviewMedia,
  isCopyrightTier = false,
  imageTrust: AccessTier = isCopyrightTier ? 'copyright-required' : 'auth-required',
) {
  return mediaWhere(media, isCopyrightTier, imageTrust);
}

/** Selected-ID hydration is already bounded. Recheck attachment presence here;
 * the caller resolves current images before delivery. Sending the full index
 * again would add thousands of binds to this point read. */
export function mediaAttachmentWhere(media?: ReviewMedia, isCopyrightTier = false) {
  return mediaWhere(media, isCopyrightTier, null);
}

function mediaWhere(
  media: ReviewMedia | undefined,
  isCopyrightTier: boolean,
  imageTrust: AccessTier | null,
) {
  if (!media) return {};
  const image = () => ({ AND: [
    { imageUrl: { not: null } }, { imageUrl: { not: '' } },
    ...(imageTrust === null || imageTrust === 'copyright-required' ? [] : [{ OR: [
      { imageUrl: { in: visibleFigureKeys(imageTrust).keys } },
      { NOT: { imageUrl: { startsWith: '/figures/' } } },
    ] }]),
  ] });
  const video = { AND: [
    { clipId: { not: null } }, { clipId: { not: '' } },
    { clip: { is: isCopyrightTier ? { deletedAt: null, source: { rightsStatus: 'cleared' } } : publicClipWhere() } },
  ] };
  if (media === 'image') return image();
  if (media === 'video') return video;
  if (media === 'any') return { OR: [image(), video] };
  return {};
}

/** Only fields produced by successful delivery resolution can qualify. */
export function matchesResolvedMedia(
  item: { imageUrl?: string | null; imageKey?: string | null; clip?: { url: string } | null },
  media?: ReviewMedia,
): boolean {
  if (!media) return true;
  const image = Boolean(item.imageUrl?.trim());
  const video = Boolean(item.clip?.url?.trim());
  return media === 'image' ? image : media === 'video' ? video : image || video;
}

/** Bound extra resolution work when inaccessible figures consume candidates. */
export function mediaCandidateLimit(size: number, media?: ReviewMedia): number {
  return media ? Math.min(300, size * 4) : size;
}
