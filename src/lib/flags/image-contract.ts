export const FLAG_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const FLAG_IMAGE_MAX_PIXELS = 12_000_000;
export const FLAG_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const FLAG_IMAGE_DRAFT_DAYS = 7;
export type FlagImageTarget = { type: 'card' | 'question' | 'component' | 'page'; id: string; deliveryId?: string };
export function isSameOriginImageRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin === new URL(request.url).origin && request.headers.get('sec-fetch-site') !== 'cross-site';
}
