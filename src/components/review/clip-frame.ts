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
  'mx-auto w-[min(100%,calc(60vh*var(--clip-r)))] max-sm:w-[min(100%,calc(45svh*var(--clip-r)))] [@media(max-height:500px)]:w-[min(100%,calc(36vh*var(--clip-r)))]';

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
