import type { ImageSidecar } from './types';
import { sidecarDimensions } from '@/lib/figures/types';

/**
 * The serving projection of an image sidecar.
 *
 * The full generated library (`image-library.generated.json`, ~30 MB) is a
 * provenance catalog: source URLs, hashes, dimensions, review trails, plus
 * whatever extra fields bulk sidecars carry. The serving path reads none of
 * that — it needs only what `imageKeyIsPrompt`, `canView`,
 * `assessImageSensitivity`, and `pickClientMeta` consume. Statically importing
 * the full catalog put 25.9 MB into the session function's synchronous module
 * init and was the largest single slice of the 4.7–6.5s cold-start residual
 * (2026-08-21 deepdive).
 *
 * `build-index.ts` writes this projection to `image-serving.generated.json`,
 * which is what `figures/server-loader.ts` imports. The behavioral contract —
 * a projected sidecar is indistinguishable from the full one for every
 * serving function — is pinned by `serving-projection.test.ts`; a serving
 * function that starts reading a field outside this allowlist breaks those
 * equality assertions, which is the intended loud failure.
 */
const SERVING_FIELDS = [
  // read by imageKeyIsPrompt + pickClientMeta (all classes)
  'class',
  'accessTier',
  // read by the figure delivery route before it mints a signed URL
  'personalRotation',
  'showWhen',
  'revealImageKey',
  'revealRegions',
  'imageWidth',
  'imageHeight',
  'attributionText',
  'licenseUrl',
  'altPolicy',
  // read by assessImageSensitivity
  'sensitive',
  'sensitivityReviewStatus',
  'sensitivityReviewedAt',
  'sensitivityReviewedBy',
  // diagnostic
  'condition',
  'modality',
  'keyFindings',
  // diagram + lake-reference
  'topic',
  'caption',
] as const;

/**
 * Values every serving read already substitutes for an absent field
 * (`accessTier ?? 'public'`, `showWhen ?? 'always'`, `'altPolicy' in s`
 * fallback to 'generic'). Eliding them is behaviorally free and saves
 * megabytes of repetition across ~30k entries. `sensitive: false` is NOT
 * here on purpose: behaviorally identical to absent, but it is a reviewer's
 * deliberate safety annotation.
 */
const ELIDED_DEFAULTS: Record<string, unknown> = {
  accessTier: 'public',
  showWhen: 'always',
  altPolicy: 'generic',
};

export function projectServingSidecar(sidecar: ImageSidecar): Record<string, unknown> {
  const raw = sidecar as unknown as Record<string, unknown>;
  const inferredPersonalRotation = raw.personalRotation ?? (
    raw.addedBy === 'wire-anking-images'
    || (typeof raw.source === 'string' && raw.source.toLowerCase().includes('anking step deck'))
      ? 'anking'
      : undefined
  );
  const out: Record<string, unknown> = {};
  for (const field of SERVING_FIELDS) {
    if (field === 'personalRotation' && inferredPersonalRotation !== undefined) {
      out[field] = inferredPersonalRotation;
      continue;
    }
    if (raw[field] === undefined) continue;
    if (field in ELIDED_DEFAULTS && raw[field] === ELIDED_DEFAULTS[field]) continue;
    out[field] = raw[field];
  }
  // The ingest dialect `dimensions: {w, h}` is normalised to the canonical
  // pair here, so the index carries one form and the 10,400 sidecars written
  // that way finally reach the layout with a size. `dimensions` itself stays
  // dropped with the rest of the provenance bulk.
  const size = sidecarDimensions(sidecar);
  if (size && out.imageWidth === undefined) {
    out.imageWidth = size.width;
    out.imageHeight = size.height;
  }
  return out;
}
