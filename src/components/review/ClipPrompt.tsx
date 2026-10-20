'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clipIsPrompt, type ClipPromptData } from './clip-role';
import { useClipUrlRecovery } from './clip-url-recovery';
import { CLIP_FRAME_CLASS, useClipFrame } from './clip-frame';
import { applyClipMute, observeClipAutoplay } from './clip-autoplay';
import { useClipPlaybackPreferences, writeAutoplay } from './clip-playback-preferences';
export { CLIP_AUTOPLAY_KEY } from './clip-playback-preferences';
import { isShortClipDuration, isShortClipWindow } from '@/lib/video/clip-duration';

export { clipIsPrompt };
export type { ClipPromptData };

/**
 * A short recognition window (normally 6–12 seconds, at most 15), rendered
 * as the card's stem. Actual media duration is checked before playback.
 *
 * The deliberate choices here all come from the same observation: this is a
 * *question*, not a video the learner is watching.
 *
 *  - **Looping, and one autoplay switch.** For a manoeuvre the useful watch
 *    is the third one. The switch is remembered. On, the clip starts by
 *    itself, muted. Play/Replay enables sound when the file has any. Off, nothing
 *    starts until Play. Operative clips have the audio stripped — the
 *    narration usually says the answer (see `clip-answer-leak.ts`) — so
 *    "sound" on those is silence. Clips with retained sound also start
 *    muted, as mobile browsers require; Play/Replay is the explicit gesture
 *    that enables it.
 *
 *  - **Diagnostic source titles withheld until reveal.** "Laparoscopic cholecystectomy" under
 *    an unanswered "what operation is this?" is the answer in the footer. The
 *    same reasoning already governs figure captions pre-reveal. Public-reuse
 *    credits remain available through a neutral Source disclosure at any time.
 *  - **Caption shown pre-reveal.** It says where to look without saying what is
 *    there. Without it a clip is decoration and the learner does not know which
 *    of the six things moving on screen is the question.
 */

interface ClipPromptProps {
  clip: ClipPromptData;
  /** Names what to watch for without naming the answer. */
  caption?: string | null;
  revealed: boolean;
  /** Rendered in the `lg` side pane (see `review-panes.ts`). */
  inSidePane?: boolean;
}

export function ClipPrompt({ clip, caption, revealed, inSidePane = false }: ClipPromptProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const figureRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const { src, poster, onError, unavailable: deliveryUnavailable } = useClipUrlRecovery(clip);
  const frame = useClipFrame();
  const { reducedMotion, autoplay } = useClipPlaybackPreferences();
  const audible = !clip.audioStripped;
  // One switch starts every short clip muted. Play/Replay can enable sound.
  // Off and reduced motion wait for Play.
  const shouldStart = !reducedMotion && autoplay;
  const declaredShort = isShortClipWindow(clip.startSecs, clip.endSecs);
  const mediaKey = `${clip.id}:${src}:${declaredShort ? 'short' : 'unavailable'}`;
  const [mediaStatus, setMediaStatus] = useState({ key: mediaKey, unavailable: !declaredShort });
  // Keep the status attached to the media identity. A failed asset must not
  // leave its unavailable banner behind when the card advances to a new clip.
  const mediaUnavailable = deliveryUnavailable || (mediaStatus.key === mediaKey
    ? mediaStatus.unavailable
    : !declaredShort);
  // Set when the browser refuses play(). The clip then waits for a tap.
  const [needsTap, setNeedsTap] = useState(false);

  // Keep playback controls and the source disclosure above the fixed answer
  // bar. Long stems and enlarged text retain a useful minimum and may scroll.
  useLayoutEffect(() => {
    const figure = figureRef.current;
    const element = frameRef.current;
    if (!figure || !element) return;
    const root = element.closest('[data-review-content]')?.parentElement ?? document;
    const footer = [...root.querySelectorAll('[data-review-footer]')]
      .find(candidate => candidate.getBoundingClientRect().height > 0);
    const fit = () => {
      const viewportBottom = window.visualViewport?.height ?? window.innerHeight;
      const bottom = Math.min(viewportBottom, footer?.getBoundingClientRect().top ?? viewportBottom);
      const rect = element.getBoundingClientRect();
      const controls = figure.getBoundingClientRect().bottom - rect.bottom;
      const height = Math.max(viewportBottom <= 500 ? 100 : 120, bottom - rect.top - controls - 8);
      const width = `${height * frame.ratio}px`;
      if (element.style.maxWidth !== width) element.style.maxWidth = width;
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(figure);
    if (footer) observer?.observe(footer);
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
    };
  }, [frame.ratio, src, revealed]);

  const settle = useCallback((pending: Promise<void> | undefined) => {
    if (pending && typeof pending.then === 'function') {
      void pending.then(
        () => setNeedsTap(false),
        () => setNeedsTap(true),
      );
    }
  }, []);

  const playFromStart = useCallback((withSound: boolean) => {
    const video = videoRef.current;
    if (!video || !declaredShort || !isShortClipDuration(video.duration)) {
      if (video && declaredShort && Number.isNaN(video.duration)) return;
      setMediaStatus({ key: mediaKey, unavailable: true });
      video?.pause();
      return;
    }
    applyClipMute(video, !withSound);
    video.currentTime = 0;
    settle(video.play());
  }, [declaredShort, mediaKey, settle]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.setAttribute('fetchpriority', 'high');
    if (!declaredShort) {
      video.removeAttribute('src');
      video.pause();
      return;
    }
    return observeClipAutoplay(video, {
      enabled: shouldStart,
      onDuration: valid => setMediaStatus({ key: mediaKey, unavailable: !valid }),
      onBlocked: setNeedsTap,
    });
  }, [clip.id, src, declaredShort, mediaKey, shouldStart]);

  const replay = useCallback(() => {
    playFromStart(audible);
  }, [audible, playFromStart]);

  const toggleAutoplay = useCallback(() => {
    const next = !autoplay;
    // Enabling automatic playback always starts muted, including on Safari.
    if (next) playFromStart(false);
    else {
      videoRef.current?.pause();
      setNeedsTap(true);
    }
    writeAutoplay(next);
  }, [autoplay, playFromStart]);

  const label = [
    audible ? 'Clip with sound.' : 'Silent clinical clip.',
    caption ?? (audible ? 'Listen, then answer below.' : 'Watch the clip and answer below.'),
  ].join(' ');

  return (
    <figure ref={figureRef} className={`my-3 [@media(max-height:500px)]:my-1 ${inSidePane ? 'lg:my-0' : ''}`}>
      <div ref={frameRef} className={`${CLIP_FRAME_CLASS} relative rounded-lg overflow-hidden border border-[var(--md-outline-variant)] bg-black`} style={frame.frameStyle}>
        <video
          ref={videoRef}
          key={`${clip.id}:${declaredShort ? src : 'unavailable'}`}
          src={declaredShort ? src : undefined}
          poster={poster ?? undefined}
          onError={onError}
          muted
          loop
          playsInline
          preload={declaredShort ? 'metadata' : 'none'}
          autoPlay={false}
          aria-label={label}
          onLoadedMetadata={frame.onLoadedMetadata}
          style={frame.videoStyle}
          className="block w-full h-auto object-contain"
        />
        {mediaUnavailable && (
          <div className="absolute inset-x-2 bottom-2 rounded bg-[var(--md-inverse-surface)] px-2 py-1 text-xs text-[var(--md-inverse-on-surface)]" role="status">
            Clip unavailable for this card.
          </div>
        )}
      </div>

      <div className="mt-2 flex items-start justify-between gap-3">
        {caption ? (
          <figcaption className="text-sm text-[var(--md-on-surface-variant)] leading-snug">
            {caption}
          </figcaption>
        ) : <span />}
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            aria-pressed={autoplay}
            onClick={toggleAutoplay}
            className={`min-h-[32px] px-2.5 py-1 rounded-md border bg-[var(--md-surface-container-lowest)] text-xs font-medium cursor-pointer transition-colors hover:border-[var(--md-primary)] hover:text-[var(--md-primary)] ${autoplay ? 'border-[var(--md-primary)] text-[var(--md-primary)]' : 'border-[var(--md-outline-variant)] text-[var(--md-on-surface-variant)]'}`}
          >
            {autoplay ? 'Autoplay on' : 'Autoplay off'}
          </button>
          <button
            type="button"
            onClick={replay}
            className="min-h-[32px] px-2.5 py-1 rounded-md border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)] text-xs font-medium text-[var(--md-on-surface-variant)] hover:border-[var(--md-primary)] hover:text-[var(--md-primary)] cursor-pointer transition-colors"
          >
            {!shouldStart || needsTap ? 'Play' : 'Replay'}
          </button>
        </div>
      </div>

      {revealed ? <ClipAttribution clip={clip} /> : clip.publicReuse ? (
        <details className="mt-1.5 text-xs text-[var(--md-on-surface-variant)]">
          <summary className="cursor-pointer">Source · {clip.sourceLicence}</summary>
          <ClipAttribution clip={clip} />
        </details>
      ) : null}
    </figure>
  );
}

function sourceLink(clip: ClipPromptData): string {
  if (clip.publicReuse) return clip.sourceUrl;
  try {
    const url = new URL(clip.sourceUrl);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) {
      return clip.sourceUrl;
    }
    url.searchParams.set('t', String(Math.floor(clip.startSecs)));
    return url.toString();
  } catch {
    return clip.sourceUrl;
  }
}

function ClipAttribution({ clip }: { clip: ClipPromptData }) {
  return (
    <div className="mt-1.5 text-xs text-[var(--md-on-surface-variant)]">
      <a
        href={sourceLink(clip)}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:underline text-[var(--md-primary)]"
      >
        {clip.sourceTitle}
      </a>
      {clip.publicReuse ? <span> · {clip.publicReuse.copyright}</span>
        : clip.sourceAuthor && <span> · {clip.sourceAuthor}</span>}
      <span> · {Math.round(clip.endSecs - clip.startSecs)}s from {formatTimestamp(clip.startSecs)}</span>
      {clip.sourceLicenceUrl && (
        <span> · <a href={clip.sourceLicenceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline text-[var(--md-primary)]">
          {clip.sourceLicence ?? 'Creative Commons licence'}
        </a> · {clip.publicReuse?.changes ?? 'adapted excerpt'}</span>
      )}
    </div>
  );
}

function formatTimestamp(secs: number): string {
  const total = Math.floor(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
