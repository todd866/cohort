export const FLAG_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Largest image sent as-is. The upload is base64 in a JSON body and Vercel
 * refuses function bodies over 4.5 MB, so a file above ~3.2 MB cannot reach
 * the route unshrunk; the device re-encodes those (fit-flag-image.ts).
 */
export const FLAG_IMAGE_PASSTHROUGH_BYTES = 3 * 1024 * 1024;
export const FLAG_IMAGE_MAX_PIXELS = 12_000_000;
export const FLAG_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const FLAG_IMAGE_DRAFT_DAYS = 7;
export type FlagImageTarget = { type: 'card' | 'question' | 'component' | 'page'; id: string; deliveryId?: string };
export function isSameOriginImageRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin === new URL(request.url).origin && request.headers.get('sec-fetch-site') !== 'cross-site';
}
