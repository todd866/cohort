'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';
import { applyClipMute } from './clip-autoplay';

/**
 * The whole picture is the control, as in a social-video feed: a short clip
 * starts by itself, a tap pauses it and a second tap resumes it. Nothing sits
 * over the footage while it plays. A centred play mark appears only when the
 * clip is waiting on the learner — after a tap-to-pause, or when the phone
 * refused to start it (iOS Low Power Mode blocks even muted autoplay).
 *
 * Mouse-down is cancelled so a click never leaves focus on this layer; Space
 * must keep revealing the card rather than toggling the clip.
 */
export function ClipTapLayer({ videoRef, audible, blocked, label }: {
  videoRef: RefObject<HTMLVideoElement | null>;
  audible: boolean;
  /** The browser refused the automatic start. */
  blocked: boolean;
  label: string;
}) {
  const [waiting, setWaiting] = useState(false);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlaying = () => setWaiting(false);
    const onVolume = () => setMuted(video.muted);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('volumechange', onVolume);
    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('volumechange', onVolume);
    };
  }, [videoRef]);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      setWaiting(false);
      const pending = video.play();
      if (pending && typeof pending.then === 'function') {
        void pending.then(undefined, () => setWaiting(true));
      }
    } else {
      video.pause();
      setWaiting(true);
    }
  }, [videoRef]);

  const toggleSound = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    applyClipMute(video, !video.muted);
    setMuted(video.muted);
    // Unmuting is the gesture that also starts a clip the phone held back.
    if (video.paused) void video.play()?.catch(() => setWaiting(true));
  }, [videoRef]);

  const showPlay = waiting || blocked;
  return (
    <>
      <button
        type="button"
        aria-label={`${showPlay ? 'Play' : 'Pause'} clip. ${label}`}
        onMouseDown={event => event.preventDefault()}
        onClick={toggle}
        className="absolute inset-0 flex items-center justify-center cursor-pointer bg-transparent"
      >
        {showPlay && (
          <span aria-hidden className="flex h-16 w-16 items-center justify-center rounded-full bg-black/55 text-white">
            <svg viewBox="0 0 24 24" className="ml-1 h-8 w-8" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </span>
        )}
      </button>
      {audible && (
        <button
          type="button"
          aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
          aria-pressed={!muted}
          onMouseDown={event => event.preventDefault()}
          onClick={toggleSound}
          className="absolute bottom-2 right-2 flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white cursor-pointer"
        >
          <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
            <path d="M4 9v6h4l5 4V5L8 9H4z" />
            {muted
              ? <path d="M16 9.4 17.4 8l2.1 2.1L21.6 8 23 9.4l-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1z" />
              : <path d="M16 8.5a4.5 4.5 0 0 1 0 7v-7zM16 4.5a8.5 8.5 0 0 1 0 15v-2.1a6.5 6.5 0 0 0 0-10.8z" />}
          </svg>
        </button>
      )}
    </>
  );
}
