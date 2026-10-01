import type { ImageSidecar } from '@/lib/images/types';

const FIGURES_PREFIX = '/figures/';

type SidecarLookup = (key: string | undefined) => ImageSidecar | undefined;

export type ImageRole = string | null | undefined;

/**
 * A question that POINTS AT the picture — "name structure 22 in the
 * photograph", "the rash shown below" — cannot be answered while the picture
 * is hidden.
 *
 * Deliberately deictic only. "an abdominal X-ray shows the mosaic pattern"
 * names a modality in the teaching text and refers to nothing on this card;
 * matching that would drag an ordinary recall card's reveal figure into the
 * prompt and give the answer away.
 */
const FIGURE_DEIXIS =
  /\b(?:in|on)\s+the\s+(?:photograph|photo|image|figure|picture|diagram)\b|\bshown\s+(?:below|here|above)\b|\bpictured\b|\bthis\s+(?:photograph|photo|image|figure|picture)\b/i;

export function frontRequiresFigure(front: string | null | undefined): boolean {
  return !!front && FIGURE_DEIXIS.test(front);
}

/**
 * Client/runtime placement rule. An explicit database role is authoritative;
 * metadata is consulted only for legacy rows written before imageRole existed.
 *
 * A front that refers to the figure overrides both, because the alternative is
 * an unanswerable card. Measured live on 2026-09-19: "Posterior Abdominal Wall
 * — name structure 49 in the photograph" rendered with no image at all until
 * the answer was revealed, and 7,272 cards whose front refers to the picture
 * carried a null role, which renders reveal-only. Only 17 were marked prompt.
 */
export function itemImageIsPrompt(
  imageRole: ImageRole,
  meta: { class?: string; showWhen?: string } | null | undefined,
  front?: string | null,
): boolean {
  if (imageRole === 'prompt') return true;
  if (frontRequiresFigure(front)) return true;
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
