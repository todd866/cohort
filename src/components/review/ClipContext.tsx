'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { isShortClipDuration, isShortClipWindow } from '@/lib/video/clip-duration';
import { useClipPlaybackPreferences } from './clip-playback-preferences';
import type { ClipPromptData } from './clip-role';
import { useClipUrlRecovery } from './clip-url-recovery';
import { CLIP_FRAME_CLASS, useClipFrame } from './clip-frame';
import { observeClipAutoplay } from './clip-autoplay';

/** Teaching footage appears only after reveal. Short excerpts loop and may
 * start muted when visible; full operations remain opt-in and play once. Both
 * the declared source window and measured media duration must fit the short
 * limit before autoplay.
 */

interface ClipContextProps {
  clip: ClipPromptData;
  revealed: boolean;
  /** Names what the video demonstrates. Safe to show — the answer is already out. */
  caption?: string | null;
}

export function ClipContext({ clip, revealed, caption }: ClipContextProps) {
  if (!revealed) return null;
  return <RevealedClipContext clip={clip} caption={caption} />;
}

/** Split so the recovery hook mounts only with the video it belongs to. */
function RevealedClipContext({ clip, caption }: Omit<ClipContextProps, 'revealed'>) {
  const { src, poster, onError, unavailable } = useClipUrlRecovery(clip);
  const frame = useClipFrame();
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const { autoplay, reducedMotion } = useClipPlaybackPreferences();
  const isShort = isShortClipWindow(clip.startSecs, clip.endSecs);
  const shouldStart = isShort && autoplay && !reducedMotion;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return observeClipAutoplay(video, {
      enabled: shouldStart,
      // A source window alone cannot establish the delivered asset's length.
      // Validate looping even when autoplay is disabled and Play is manual.
      onDuration: valid => { video.loop = isShort && valid; },
    });
  }, [isShort, shouldStart, src]);
  // Keep native transport controls above the fixed grading bar, including
  // after text enlargement. Retain a useful minimum and allow reading scroll
  // when the stem itself occupies most of a very short viewport.
  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const root = element.closest('[data-review-content]')?.parentElement ?? document;
    const footer = [...root.querySelectorAll('[data-review-footer]')]
      .find(candidate => candidate.getBoundingClientRect().height > 0);
    const fit = () => {
      const viewportBottom = window.visualViewport?.height ?? window.innerHeight;
      const bottom = Math.min(viewportBottom, footer?.getBoundingClientRect().top ?? viewportBottom);
      const minimum = viewportBottom <= 500 ? 100 : 160;
      const height = Math.max(minimum, bottom - element.getBoundingClientRect().top - 8);
      const width = `${height * frame.ratio}px`;
      if (element.style.maxWidth !== width) element.style.maxWidth = width;
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(element.parentElement ?? element);
    if (footer) observer?.observe(footer);
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
    };
  }, [frame.ratio, src]);
  const durationSecs = Math.max(0, Math.round(clip.endSecs - clip.startSecs));

  return (
    <figure className="review-reveal my-3 [@media(max-height:500px)]:my-1">
      {unavailable && <p role="status" className="text-sm text-[var(--md-on-surface-variant)]">Clip unavailable for this card.</p>}
      <div ref={frameRef} className={`${CLIP_FRAME_CLASS} rounded-lg overflow-hidden border border-[var(--md-outline-variant)] bg-black`} style={frame.frameStyle}>
        <video
          key={src}
          ref={videoRef}
          src={src}
          poster={poster ?? undefined}
          onError={onError}
          controls
          loop={false}
          onDurationChange={event => {
            event.currentTarget.loop = isShort && isShortClipDuration(event.currentTarget.duration);
          }}
          onEmptied={event => { event.currentTarget.loop = false; }}
          playsInline
          preload={shouldStart ? 'metadata' : 'none'}
          muted
          onLoadedMetadata={frame.onLoadedMetadata}
          style={frame.videoStyle}
          className="block w-full h-auto object-contain"
        />
      </div>
      {caption && (
        <figcaption className="mt-2 text-sm text-[var(--md-on-surface-variant)] leading-snug">
          {caption}
        </figcaption>
      )}
      <details className="mt-1.5 text-xs text-[var(--md-on-surface-variant)]">
        <summary className="cursor-pointer">Source · {formatDuration(durationSecs)}</summary>
        <a
          href={clip.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline text-[var(--md-primary)]"
        >
          {clip.sourceTitle}
        </a>
        {clip.publicReuse ? <span> · {clip.publicReuse.copyright}</span>
          : clip.sourceAuthor && <span> · {clip.sourceAuthor}</span>}
        {clip.sourceLicenceUrl && (
          <span> · <a href={clip.sourceLicenceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline text-[var(--md-primary)]">
            {clip.sourceLicence ?? 'Creative Commons licence'}
          </a> · {clip.publicReuse?.changes ?? 'adapted excerpt'}</span>
        )}
      </details>
    </figure>
  );
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
