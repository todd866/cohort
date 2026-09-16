import 'server-only';
import imageLibrary from '@/data/image-serving.generated.json';
import type { ImageSidecar } from '@/lib/images/types';

// The SERVING projection, not the full catalog. This module sits at module
// scope of the session route (and the review page), so its import is paid on
// every cold start — the full 30 MB image-library.generated.json here was
// 25.9 MB of the route's 27.6 MB synchronous entry weight and the largest
// slice of the 4.7–6.5s cold-start residual (2026-08-21 deepdive). The
// projection carries exactly the fields the serving path reads; the
// behavioral contract is pinned by serving-projection.test.ts. Scripts and
// audits that need provenance keep reading the full catalog.
const lib = imageLibrary as unknown as Record<string, ImageSidecar>;

/** Server-only sidecar lookup. Do NOT import this from a client component. */
export function lookupSidecar(key: string | undefined): ImageSidecar | undefined {
  if (typeof key !== 'string') return undefined;
  return lib[key];
}
