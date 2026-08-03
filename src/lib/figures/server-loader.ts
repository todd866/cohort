import 'server-only';
import imageLibrary from '@/data/image-library.generated.json';
import type { ImageSidecar } from '@/lib/images/types';

const lib = imageLibrary as unknown as Record<string, ImageSidecar>;

/** Server-only sidecar lookup. Do NOT import this from a client component. */
export function lookupSidecar(key: string | undefined): ImageSidecar | undefined {
  if (typeof key !== 'string') return undefined;
  return lib[key];
}
