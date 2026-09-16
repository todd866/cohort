'use client';

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { clipIsPrompt, type ClipPromptData } from './clip-role';
import { useClipUrlRecovery } from './clip-url-recovery';

export { clipIsPrompt };
export type { ClipPromptData };

/**
 * A 6-10 second window of an operation, rendered as the card's stem.
 *
 * The deliberate choices here all come from the same observation: this is a
 * *question*, not a video the learner is watching.
 *
 *  - **Muted, looping, autoplaying.** For a manoeuvre the useful watch is the
 *    third one. A play button costs a tap before the question even starts, and
 *    a clip that stops after one pass makes the learner hunt for the control
 *    instead of thinking. Audio is stripped upstream anyway — the narration
 *    usually says the answer (see `clip-answer-leak.ts`) — so muting loses
 *    nothing and buys autoplay, which browsers only permit when muted.
 *  - **Attribution withheld until reveal.** "Laparoscopic cholecystectomy" under
 *    an unanswered "what operation is this?" is the answer in the footer. The
 *    same reasoning already governs figure captions pre-reveal.
 *  - **Caption shown pre-reveal.** It says where to look without saying what is
 *    there. Without it a clip is decoration and the learner does not know which
 *    of the six things moving on screen is the question.
 */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof matchMedia !== 'function') return null;
  try {
    return matchMedia(REDUCED_MOTION_QUERY);
  } catch {
    return null;
  }
}

/**
 * Read as an external store rather than an effect-plus-setState. The preference
 * is browser state that can change while the page is open, and a synchronous
 * setState in an effect re-renders every mount of this component for a value
 * that is usually false. The server snapshot is false so the first paint agrees
 * with the markup; a viewer who does prefer reduced motion gets one correction
 * on hydration, before the clip has loaded enough to play anyway.
 */
function subscribeReducedMotion(onChange: () => void): () => void {
  const query = reducedMotionQuery();
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

function getReducedMotion(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

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
  const { src, poster, onError } = useClipUrlRecovery(clip);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotion,
    () => false,
  );

  const replay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    // Autoplay can be refused (a background tab, a strict setting). The promise
    // rejection is not actionable here and must not surface as an unhandled
    // rejection in the learner's console.
    void Promise.resolve(video.play()).catch(() => {});
  }, []);

  const label = [
    'Silent operative clip.',
    caption ?? 'Watch the clip and answer below.',
  ].join(' ');

  return (
    <figure className={`my-3 ${inSidePane ? 'lg:my-0' : ''}`}>
      <div className="relative rounded-lg overflow-hidden border border-[var(--md-outline-variant)] bg-black">
        <video
          ref={videoRef}
          src={src}
          poster={poster ?? undefined}
          onError={onError}
          muted
          loop
          playsInline
          preload="auto"
          autoPlay={!reducedMotion}
          aria-label={label}
          className="w-full h-auto max-h-[60vh] object-contain"
        />
      </div>

      <div className="mt-2 flex items-start justify-between gap-3">
        {caption ? (
          <figcaption className="text-sm text-[var(--md-on-surface-variant)] leading-snug">
            {caption}
          </figcaption>
        ) : <span />}
        <button
          type="button"
          onClick={replay}
          className="shrink-0 min-h-[32px] px-2.5 py-1 rounded-md border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)] text-xs font-medium text-[var(--md-on-surface-variant)] hover:border-[var(--md-primary)] hover:text-[var(--md-primary)] cursor-pointer transition-colors"
        >
          {reducedMotion ? 'Play' : 'Replay'}
        </button>
      </div>

      {revealed && (
        <div className="mt-1.5 text-xs text-[var(--md-on-surface-variant)]">
          <a
            href={`${clip.sourceUrl}${clip.sourceUrl.includes('?') ? '&' : '?'}t=${Math.floor(clip.startSecs)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline text-[var(--md-primary)]"
          >
            {clip.sourceTitle}
          </a>
          <span> · {Math.round(clip.endSecs - clip.startSecs)}s from {formatTimestamp(clip.startSecs)}</span>
        </div>
      )}
    </figure>
  );
}

function formatTimestamp(secs: number): string {
  const total = Math.floor(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
