import imageLibrary from '@/data/image-serving.generated.json';
import type { ImageSidecar } from '@/lib/images/types';

// The SERVING projection, not the full catalog. This data sits at module scope
// of session routes and review pages, so importing the full 30 MB
// image-library.generated.json here would dominate cold-start weight. The
// projection carries exactly the fields serving policy reads and is pinned by
// serving-projection.test.ts. This module is also script-safe: it contains no
// credentials or signing logic. Server entry points should normally import
// server-loader so Next can enforce the server-component boundary.
const library = imageLibrary as unknown as Record<string, ImageSidecar>;

export function lookupServingSidecar(key: string | undefined): ImageSidecar | undefined {
  if (typeof key !== 'string') return undefined;
  return library[key];
}
