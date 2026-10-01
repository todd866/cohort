import 'server-only';

import { auth } from '@/lib/auth';
import { resolveImage } from '@/lib/figures/resolve';
import { shouldGateClientImageMeta } from '@/lib/figures/types';
import { SensitiveMediaGate } from '@/components/media/SensitiveMediaGate';
import {
  ImageOcclusion as ImageOcclusionClient,
  type ImageOcclusionProps,
} from './ImageOcclusion';

/** Server boundary for directly authored MDX <ImageOcclusion> components.
 * FigureClient owns the equivalent boundary for its review-mode occlusions. */
export async function ImageOcclusion(props: ImageOcclusionProps) {
  const stableSrc = typeof props.src === 'string' ? props.src : props.src.src;

  // External/bundled sources have no sidecar, so they pass through ungated.
  // Consent gating is opt-in via explicit sensitive metadata on /figures/ keys.
  if (!stableSrc.startsWith('/figures/')) {
    return <ImageOcclusionClient {...props} />;
  }

  const session = await auth();
  const resolved = await resolveImage(stableSrc, session);
  if (!resolved) return null;

  return (
    <SensitiveMediaGate
      consentKey={`image-occlusion:${props.id}:${resolved.imageKey}`}
      sensitive={shouldGateClientImageMeta(
        resolved.imageMeta,
        resolved.imageKey,
      )}
    >
      <ImageOcclusionClient {...props} src={resolved.imageUrl} />
    </SensitiveMediaGate>
  );
}
