'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isShortClipDuration, isShortClipWindow } from '@/lib/video/clip-duration';
import type { ClipPromptData } from './clip-role';
import { useClipUrlRecovery } from './clip-url-recovery';
import { applyClipFrameWidth, CLIP_FRAME_CLASS, useClipFrame } from './clip-frame';
import { observeClipAutoplay } from './clip-autoplay';
import { ClipTapLayer } from './clip-tap-layer';
import { SensitiveMediaGate, useSensitiveMediaConcealed } from '@/components/media/SensitiveMediaGate';

/** Teaching footage appears only after reveal. A short excerpt plays like the
 * prompt clip: it starts muted when visible, loops, fills the phone's width and
 * a tap pauses it, with no control bar. A full operation keeps the native
 * controls, stays opt-in and plays once. Both the declared source window and
 * the measured media duration must fit the short limit before autoplay.
 */

interface ClipContextProps {
  clip: ClipPromptData;
  revealed: boolean;
  /** Names what the video demonstrates. Safe to show — the answer is already out. */
  caption?: string | null;
  /** The review item showing this clip; consent belongs to one occurrence. */
  occurrenceKey?: string;
}

export function ClipContext({ clip, revealed, caption, occurrenceKey }: ClipContextProps) {
  if (!revealed) return null;
  return <RevealedClipContext clip={clip} caption={caption} occurrenceKey={occurrenceKey} />;
}

/** Split so the recovery hook mounts only with the video it belongs to. A clip
 * on the reviewed sensitive list waits behind the shared gate while Blur
 * images is on, and does not start until shown. */
function RevealedClipContext({ clip, caption, occurrenceKey }: Omit<ClipContextProps, 'revealed'>) {
  const durationSecs = Math.max(0, Math.round(clip.endSecs - clip.startSecs));
  return (
    <figure className="review-reveal my-3 [@media(max-height:500px)]:my-1">
      <SensitiveMediaGate
        consentKey={`${occurrenceKey ?? 'clip'}:${clip.id}:context`}
        sensitive={clip.sensitive === true}
        mediaKind="clip"
      >
        <ClipContextFrame clip={clip} caption={caption} />
      </SensitiveMediaGate>
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

function ClipContextFrame({ clip, caption }: { clip: ClipPromptData; caption?: string | null }) {
  const { src, poster, onError, unavailable } = useClipUrlRecovery(clip);
  const frame = useClipFrame();
  const concealed = useSensitiveMediaConcealed();
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const isShort = isShortClipWindow(clip.startSecs, clip.endSecs);
  const [blocked, setBlocked] = useState(false);
  // A declared-short window whose delivered file runs long falls back to the
  // native controls and manual play, like a full operation.
  const [tooLongFor, setTooLongFor] = useState<string | null>(null);
  const feedClip = isShort && tooLongFor !== src;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return observeClipAutoplay(video, {
      // Concealed: stay on the poster with metadata only, never start.
      enabled: isShort && !concealed,
      // A source window alone cannot establish the delivered asset's length.
      onDuration: valid => {
        video.loop = isShort && valid;
        setTooLongFor(current => valid ? (current === src ? null : current) : src);
      },
      onBlocked: setBlocked,
    });
  }, [isShort, src, concealed]);
  // Keep the picture (and a long clip's native controls) above the fixed grading bar, including
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
      applyClipFrameWidth(element, height, frame.ratio);
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

  return (
    <>
      {unavailable && <p role="status" className="text-sm text-[var(--md-on-surface-variant)]">Clip unavailable for this card.</p>}
      <div ref={frameRef} className={`${CLIP_FRAME_CLASS} relative rounded-lg overflow-hidden border border-[var(--md-outline-variant)] bg-black`} style={frame.frameStyle}>
        <video
          key={src}
          ref={videoRef}
          src={src}
          poster={poster ?? undefined}
          onError={onError}
          controls={!feedClip && !concealed}
          loop={false}
          onDurationChange={event => {
            event.currentTarget.loop = isShort && isShortClipDuration(event.currentTarget.duration);
          }}
          onEmptied={event => { event.currentTarget.loop = false; }}
          playsInline
          preload={isShort ? 'metadata' : 'none'}
          muted
          onLoadedMetadata={frame.onLoadedMetadata}
          style={frame.videoStyle}
          className="block w-full h-auto object-contain"
        />
        {feedClip && !unavailable && !concealed && (
          <ClipTapLayer key={`tap:${src}`} videoRef={videoRef} audible={!clip.audioStripped} blocked={blocked} label={caption ?? 'Teaching clip.'} />
        )}
      </div>
    </>
  );
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
