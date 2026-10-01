import imageLibrary from '@/data/image-library.generated.json';
import type { ImageSidecar } from './types';

const lib = imageLibrary as unknown as Record<string, ImageSidecar>;

export function lookupSidecar(src: string | undefined): ImageSidecar | undefined {
  if (typeof src !== 'string') return undefined;
  return lib[src];
}
