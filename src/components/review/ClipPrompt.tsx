'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SensitiveMediaGate, useSensitiveMediaConcealed } from '@/components/media/SensitiveMediaGate';
import { clipIsPrompt, type ClipPromptData } from './clip-role';
import { useClipUrlRecovery } from './clip-url-recovery';
import { applyClipFrameWidth, CLIP_FRAME_CLASS, useClipFrame } from './clip-frame';
import { observeClipAutoplay } from './clip-autoplay';
import { ClipTapLayer } from './clip-tap-layer';
import { isShortClipWindow } from '@/lib/video/clip-duration';

export { clipIsPrompt };
export type { ClipPromptData };

/**
 * A short recognition window (normally 6–12 seconds, at most 15), rendered
 * as the card's stem. Actual media duration is checked before playback.
 *
 * The deliberate choices here all come from the same observation: this is a
 * *question*, not a video the learner is watching.
 *
 *  - **It just plays, like a social-video feed.** For a manoeuvre the useful
 *    watch is the third one, so the clip starts by itself when it is on
 *    screen, muted and looping, and fills the phone's width. There is no
 *    autoplay switch and no control bar: a tap on the picture pauses or
 *    resumes it (owner, 29 Oct 2026: "It should just play, as big as it can,
 *    full-width"). Operative clips have the audio stripped — the narration
 *    usually says the answer (see `clip-answer-leak.ts`). Clips with retained
 *    sound also start muted, as mobile browsers require; a speaker button on
 *    the picture turns the sound on.
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
  /**
   * The review item showing this clip. Consent to a sensitive clip belongs to
   * one occurrence: the next card reusing the clip is concealed again.
   */
  occurrenceKey?: string;
  /** Reveal/skip the answer without showing a sensitive clip. */
  onSkipSensitive?: () => void;
}

/**
 * A clip on the reviewed sensitive list (`src/lib/video/sensitive-clips.json`)
 * sits behind the shared sensitive-media gate while Blur images is on. There it
 * stays on its poster, loads no more than metadata and does not start; once
 * shown it plays like any other clip. Turning blur back on conceals and stops it.
 */
export function ClipPrompt({ clip, caption, revealed, inSidePane = false, occurrenceKey, onSkipSensitive }: ClipPromptProps) {
  const sensitive = clip.sensitive === true;
  return (
    <figure className={`my-3 [@media(max-height:500px)]:my-1 ${inSidePane ? 'lg:my-0' : ''}`}>
      <SensitiveMediaGate
        consentKey={`${occurrenceKey ?? 'clip'}:${clip.id}`}
        sensitive={sensitive}
        mediaKind="clip"
        onSkip={sensitive && !revealed ? onSkipSensitive : undefined}
        captureReviewSpace={sensitive && !revealed}
      >
        <ClipPromptFrame clip={clip} caption={caption} revealed={revealed} />
      </SensitiveMediaGate>

      {caption && (
        <figcaption className="mt-2 text-sm text-[var(--md-on-surface-variant)] leading-snug">
          {caption}
        </figcaption>
      )}

      {revealed ? <ClipAttribution clip={clip} /> : clip.publicReuse ? (
        <details className="mt-1.5 text-xs text-[var(--md-on-surface-variant)]">
          <summary className="cursor-pointer">Source · {clip.sourceLicence}</summary>
          <ClipAttribution clip={clip} />
        </details>
      ) : null}
    </figure>
  );
}

/** The picture itself. It remounts when the gate conceals or shows it, so its
 *  playback effects always start from the current consent. */
function ClipPromptFrame({ clip, caption, revealed }: {
  clip: ClipPromptData;
  caption?: string | null;
  revealed: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const concealed = useSensitiveMediaConcealed();
  const { src, poster, onError, unavailable: deliveryUnavailable } = useClipUrlRecovery(clip);
  const frame = useClipFrame();
  const audible = !clip.audioStripped;
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

  // Keep the picture and the source disclosure above the fixed answer
  // bar. Long stems and enlarged text retain a useful minimum and may scroll.
  useLayoutEffect(() => {
    const element = frameRef.current;
    // Read from the DOM: a child's layout effect runs before the parent's ref
    // is attached, so the figure ref is still null on first mount.
    const figure = element?.closest('figure');
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
      applyClipFrameWidth(element, height, frame.ratio);
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.setAttribute('fetchpriority', concealed ? 'low' : 'high');
    if (!declaredShort) {
      video.removeAttribute('src');
      video.pause();
      return;
    }
    return observeClipAutoplay(video, {
      // Concealed: stay on the poster with metadata only, never start.
      enabled: !concealed,
      onDuration: valid => setMediaStatus({ key: mediaKey, unavailable: !valid }),
      onBlocked: setNeedsTap,
    });
  }, [clip.id, src, declaredShort, mediaKey, concealed]);

  const label = [
    audible ? 'Clip with sound.' : 'Silent clinical clip.',
    caption ?? (audible ? 'Listen, then answer below.' : 'Watch the clip and answer below.'),
  ].join(' ');

  return (
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
      {declaredShort && !mediaUnavailable && !concealed && (
        <ClipTapLayer key={`tap:${clip.id}:${src}`} videoRef={videoRef} audible={audible} blocked={needsTap} label={label} />
      )}
      {mediaUnavailable && (
        <div className="absolute inset-x-2 bottom-2 rounded bg-[var(--md-inverse-surface)] px-2 py-1 text-xs text-[var(--md-inverse-on-surface)]" role="status">
          Clip unavailable for this card.
        </div>
      )}
    </div>
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
