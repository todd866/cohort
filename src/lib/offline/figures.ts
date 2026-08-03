export const FIGURE_CACHE = 'md3-public-no-figure-cache';

export function figureCacheKey(imageKey: string, ownerKey = 'unbound'): string {
  return `/__offline-figure?owner=${encodeURIComponent(ownerKey)}&key=${encodeURIComponent(imageKey)}`;
}

export async function cacheFigures(
  _imageKeys: (string | null | undefined)[],
  _expectedOwnerKey?: string | null,
): Promise<number> {
  void _imageKeys;
  void _expectedOwnerKey;
  return 0;
}

export async function readCachedFigure(_imageKey: string): Promise<null> {
  void _imageKey;
  return null;
}

export async function countCachedFigures(_expectedOwnerKey?: string): Promise<number> {
  void _expectedOwnerKey;
  return 0;
}

export async function clearFigureCache(): Promise<void> {}
