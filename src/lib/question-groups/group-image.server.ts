import 'server-only';

import { resolveImage } from '@/lib/figures/resolve';
import type { AccessTier } from '@/lib/images/types';
import groupImageKeys from './group-image-keys.json';

/**
 * Images for ECG/CXR/ABG question groups.
 *
 * Group rows stored raw image URLs: `/figures/*` paths, which direct-block
 * 404s by design, and URLs on a retired public R2 bucket, which answers 401.
 * So every picker image was broken for every viewer (found 2026-09-24).
 *
 * group-image-keys.json maps each group slug to the figure key it may show, and
 * each mapping was checked against what the group teaches. A slug mapped to
 * null has no image that shows its diagnosis: four stored images showed a
 * different one, and PTB-XL "IMI" is not an inferior STEMI with heart block.
 * Anki CXRs are mapped only when the image's sha256 prefix matches the
 * original file; a text-matched card image was a different picture.
 *
 * Images are signed per viewer through resolveImage, so the copyright-tier
 * Anki CXRs reach only copyright-tier learners.
 */
const KEYS = groupImageKeys as Record<string, string | null>;

/** These groups ask the learner to read an image; without one they are not served. */
const IMAGE_REQUIRED_TYPES = new Set(['ecg', 'cxr', 'rhythm']);

export function groupImageKey(slug: string | null | undefined, stored: string | null | undefined): string | null {
  if (slug && Object.prototype.hasOwnProperty.call(KEYS, slug)) return KEYS[slug];
  return stored?.startsWith('/figures/') ? stored : null;
}

interface GroupStep { view?: string | null; resolvedImageUrl?: string | null }

/**
 * Sign a group's context image and each step's view image for this viewer.
 * Returns null when the group needs an image this viewer cannot see.
 */
export async function resolveGroupImage<S extends GroupStep>(
  group: { slug?: string | null; type: string; contextImageUrl?: string | null; steps: S[] },
  trust: AccessTier,
): Promise<{ contextImageUrl: string | null; steps: Array<S & { resolvedImageUrl: string | null }> } | null> {
  const key = groupImageKey(group.slug, group.contextImageUrl);
  const context = key ? await resolveImage(key, null, trust) : null;
  if (!context && IMAGE_REQUIRED_TYPES.has(group.type)) return null;

  const contextUrl = context?.imageUrl ?? null;
  const steps = await Promise.all(group.steps.map(async (step) => {
    if (!step.view || !key || !/\.png$/.test(key)) return { ...step, resolvedImageUrl: contextUrl };
    const view = await resolveImage(key.replace(/\.png$/, `_${step.view}.png`), null, trust);
    return { ...step, resolvedImageUrl: view?.imageUrl ?? contextUrl };
  }));
  return { contextImageUrl: contextUrl, steps };
}
