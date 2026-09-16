import type { ImageSidecar } from '@/lib/images/types';

const FIGURES_PREFIX = '/figures/';

type SidecarLookup = (key: string | undefined) => ImageSidecar | undefined;

export type ImageRole = string | null | undefined;

/**
 * Client/runtime placement rule. An explicit database role is authoritative;
 * metadata is consulted only for legacy rows written before imageRole existed.
 */
export function itemImageIsPrompt(
  imageRole: ImageRole,
  meta: { class?: string; showWhen?: string } | null | undefined,
): boolean {
  if (imageRole === 'prompt') return true;
  return imageRole == null
    && meta?.class === 'diagnostic'
    && meta.showWhen !== 'after-reveal';
}

export function imageKeyIsPromptWithLookup(
  imageKey: string | null | undefined,
  lookupSidecar: SidecarLookup,
): boolean {
  if (!imageKey?.startsWith(FIGURES_PREFIX)) return false;
  const sidecar = lookupSidecar(imageKey);
  // Internal figure keys absent from the serving index cannot be delivered.
  // Treat them as required so callers fail closed instead of downgrading an
  // image-dependent item. External URLs remain outside this legacy inference.
  if (!sidecar) return true;
  return sidecar.class === 'diagnostic' && sidecar.showWhen !== 'after-reveal';
}

export function questionImageIsPromptWithLookup(
  imageRole: string | null | undefined,
  imageKey: string | null | undefined,
  lookupSidecar: SidecarLookup,
): boolean {
  return imageRole === 'prompt'
    || (imageRole == null && imageKeyIsPromptWithLookup(imageKey, lookupSidecar));
}
