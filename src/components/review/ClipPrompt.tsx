'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
 *  - **Looping, and one autoplay switch.** For a manoeuvre the useful watch
 *    is the third one. The switch is remembered. On, the clip starts by
 *    itself: picture, and sound when the file still has any. Off, nothing
 *    starts until Play. Operative clips have the audio stripped — the
 *    narration usually says the answer (see `clip-answer-leak.ts`) — so
 *    "sound" on those is silence, and they stay muted, which is also the
 *    only autoplay browsers allow with no gesture. A clip that kept its
 *    audio (a murmur, where the sound is the finding) starts unmuted when
 *    the switch is on. Browsers may still refuse that first unmuted play
 *    until a tap; the switch itself is that tap.
 *  - **Attribution withheld until reveal.** "Laparoscopic cholecystectomy" under
 *    an unanswered "what operation is this?" is the answer in the footer. The
 *    same reasoning already governs figure captions pre-reveal.
 *  - **Caption shown pre-reveal.** It says where to look without saying what is
 *    there. Without it a clip is decoration and the learner does not know which
 *    of the six things moving on screen is the question.
 */

/** Remembered across cards. Absent or `on` means the next clip starts by itself. */
export const CLIP_AUTOPLAY_KEY = 'md3.clipAutoplay';
const AUTOPLAY_EVENT = 'md3-clip-autoplay';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeAutoplay(onChange: () => void): () => void {
  window.addEventListener(AUTOPLAY_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(AUTOPLAY_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

function autoplayEnabled(): boolean {
  try {
    const stored = localStorage.getItem(CLIP_AUTOPLAY_KEY)
      ?? localStorage.getItem('md3.clipAudibleAutoplay');
    return stored !== 'off';
  } catch {
    return true;
  }
}

function writeAutoplay(on: boolean): void {
  try {
    localStorage.setItem(CLIP_AUTOPLAY_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode can refuse the write. The in-memory store update still
    // applies for this page.
  }
  window.dispatchEvent(new Event(AUTOPLAY_EVENT));
}

function applyMute(video: HTMLVideoElement, mute: boolean): void {
  video.muted = mute;
  video.defaultMuted = mute;
  if (mute) video.setAttribute('muted', '');
  else video.removeAttribute('muted');
}

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
  const audible = !clip.audioStripped;
  const autoplay = useSyncExternalStore(
    subscribeAutoplay,
    autoplayEnabled,
    () => true,
  );
  // One switch for every clip. On starts the picture, and the sound when
  // the file still has any. Off waits for Play. Reduced motion waits either way.
  const shouldStart = !reducedMotion && autoplay;
  // Set when the browser refuses play(). The clip then waits for a tap.
  const [needsTap, setNeedsTap] = useState(false);

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
    if (!video) return;
    applyMute(video, !withSound);
    video.currentTime = 0;
    settle(video.play());
  }, [settle]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Safari grants autoplay from the content attribute. React's `muted` prop
    // has a long history of setting only the DOM property, so the attribute
    // is missing, the policy treats a silent clip as audible, and the poster
    // sits there until someone hits the button. Set both, then call play()
    // once data is in.
    applyMute(video, !audible);
    video.setAttribute('fetchpriority', 'high');
    if (!shouldStart) {
      video.pause();
      return;
    }
    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      const pending = video.play();
      if (pending && typeof pending.then === 'function') {
        void pending.then(
          () => { if (!cancelled) setNeedsTap(false); },
          () => { if (!cancelled) setNeedsTap(true); },
        );
      }
    };
    video.addEventListener('loadeddata', start);
    if (video.readyState >= 2) start();
    return () => {
      cancelled = true;
      video.removeEventListener('loadeddata', start);
    };
  }, [src, audible, shouldStart]);

  const replay = useCallback(() => {
    playFromStart(audible);
  }, [audible, playFromStart]);

  const toggleAutoplay = useCallback(() => {
    const next = !autoplay;
    // play() has to run inside the click. An effect after paint is outside
    // the gesture, and the browser will refuse the sound.
    if (next) playFromStart(audible);
    else {
      videoRef.current?.pause();
      setNeedsTap(true);
    }
    writeAutoplay(next);
  }, [autoplay, audible, playFromStart]);

  const label = [
    audible ? 'Clip with sound.' : 'Silent operative clip.',
    caption ?? (audible ? 'Listen, then answer below.' : 'Watch the clip and answer below.'),
  ].join(' ');

  return (
    <figure className={`my-3 ${inSidePane ? 'lg:my-0' : ''}`}>
      <div className="relative rounded-lg overflow-hidden border border-[var(--md-outline-variant)] bg-black">
        <video
          ref={videoRef}
          src={src}
          poster={poster ?? undefined}
          onError={onError}
          muted={!audible}
          loop
          playsInline
          preload="auto"
          autoPlay={shouldStart}
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
