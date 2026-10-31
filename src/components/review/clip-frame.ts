import { useCallback, useState, type CSSProperties, type SyntheticEvent } from 'react';

/** Until a clip's metadata arrives, reserve a 16:9 frame so nothing jumps. */
export const DEFAULT_CLIP_RATIO = 16 / 9;

/**
 * The frame takes the clip's own shape. A fixed 16:9 box letterboxed 4:3
 * operative footage with black bars down both sides. Width is the lesser of
 * the column and the height cap times the ratio, so a tall clip narrows
 * instead of growing bars.
 */
export const CLIP_FRAME_CLASS =
  'mx-auto w-[min(100%,calc(60vh*var(--clip-r)))] max-sm:w-[min(100%,calc(45svh*var(--clip-r)))] [@media(max-height:500px)]:w-[min(100%,calc(36vh*var(--clip-r)))]'
  // On a phone a clip that can fill the width runs edge to edge, past the card
  // padding, the way a social-video feed shows it.
  + ' max-sm:data-[bleed]:w-screen max-sm:data-[bleed]:max-w-none max-sm:data-[bleed]:ml-[calc(50%-50vw)] max-sm:data-[bleed]:rounded-none max-sm:data-[bleed]:border-x-0';

/** Narrower than this, a clip that fits the screen width bleeds to its edges. */
const PHONE_MAX_WIDTH = 640;

/**
 * Cap the frame at the width its available height allows. On a phone, when
 * that cap is at least the screen width, drop it and bleed edge to edge.
 */
export function applyClipFrameWidth(element: HTMLElement, height: number, ratio: number): void {
  const width = height * ratio;
  const screen = window.innerWidth;
  if (screen < PHONE_MAX_WIDTH && width >= screen) {
    if (!element.hasAttribute('data-bleed')) element.setAttribute('data-bleed', '');
    if (element.style.maxWidth) element.style.maxWidth = '';
    return;
  }
  if (element.hasAttribute('data-bleed')) element.removeAttribute('data-bleed');
  const px = `${width}px`;
  if (element.style.maxWidth !== px) element.style.maxWidth = px;
}

export function clipRatio(width: number, height: number): number {
  return width > 0 && height > 0 && Number.isFinite(width / height) ? width / height : DEFAULT_CLIP_RATIO;
}

export function useClipFrame() {
  const [ratio, setRatio] = useState(DEFAULT_CLIP_RATIO);
  const onLoadedMetadata = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    setRatio(clipRatio(video.videoWidth, video.videoHeight));
  }, []);
  const frameStyle = { '--clip-r': String(ratio) } as CSSProperties;
  const videoStyle: CSSProperties = { aspectRatio: String(ratio) };
  return { ratio, onLoadedMetadata, frameStyle, videoStyle };
}
