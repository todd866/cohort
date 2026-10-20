import { isShortClipDuration } from '@/lib/video/clip-duration';

/** Safari checks the content attribute as well as the current DOM property. */
export function applyClipMute(video: HTMLVideoElement, muted: boolean): void {
  video.muted = muted;
  video.defaultMuted = muted;
  if (muted) video.setAttribute('muted', '');
  else video.removeAttribute('muted');
}

/** Only the currently visible, duration-validated excerpt may start itself.
 * Metadata alone can leave mobile Safari on a poster: once visible, ask for
 * playable data, then arm native autoplay AND attempt play after validation.
 * A rejected attempt leaves the component's explicit/native Play available.
 */
export function observeClipAutoplay(video: HTMLVideoElement, {
  enabled,
  onDuration,
  onBlocked,
}: {
  enabled: boolean;
  onDuration?: (valid: boolean) => void;
  onBlocked?: (blocked: boolean) => void;
}): () => void {
  let visible = typeof IntersectionObserver === 'undefined';
  let attempted = false;
  let disposed = false;
  applyClipMute(video, true);
  video.autoplay = false;
  if (!enabled) video.pause();

  const start = () => {
    const valid = isShortClipDuration(video.duration);
    if (!Number.isNaN(video.duration)) onDuration?.(valid);
    if (!enabled) return;
    video.preload = visible ? 'auto' : 'metadata';
    if (!visible || !valid) {
      video.autoplay = false;
      if (!valid) video.pause();
      return;
    }
    // Do not re-arm autoplay on duration/canplay events after a manual pause.
    if (attempted) return;
    attempted = true;
    applyClipMute(video, true);
    video.autoplay = true;
    try {
      void video.play()?.then(
        () => { if (!disposed) onBlocked?.(false); },
        () => { if (!disposed) onBlocked?.(true); },
      );
    } catch {
      onBlocked?.(true);
    }
  };
  const observer = typeof IntersectionObserver === 'undefined' ? null
    : new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (!visible) {
        video.autoplay = false;
        video.pause();
        attempted = false;
      }
      start();
    }, { threshold: 0 });
  observer?.observe(video);
  video.addEventListener('loadedmetadata', start);
  video.addEventListener('durationchange', start);
  video.addEventListener('canplay', start);
  start();
  return () => {
    disposed = true;
    observer?.disconnect();
    video.removeEventListener('loadedmetadata', start);
    video.removeEventListener('durationchange', start);
    video.removeEventListener('canplay', start);
    video.autoplay = false;
    video.pause();
  };
}
