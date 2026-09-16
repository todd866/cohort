'use client';

import type { ClipPromptData } from './clip-role';
import { useClipUrlRecovery } from './clip-url-recovery';

/**
 * A full-length operative video shown as teaching context AFTER the answer.
 *
 * The counterpart to `ClipPrompt`, and almost its opposite in every choice,
 * because it answers a different question. A prompt clip is 6-10 seconds the
 * learner must see to answer at all, so it autoplays and preloads. A context
 * clip can be minutes long and most learners will not watch it — it is the
 * "show me the whole operation" affordance sitting under an answer they already
 * have.
 *
 * ## The performance contract
 *
 * Review is a high-frequency surface: the same learner passes through many
 * cards per session, every session. A multi-megabyte file that begins
 * downloading on every reveal would be the single most expensive thing on the
 * surface, and it would be spent mostly on videos nobody watches. So:
 *
 *  - **Not mounted until revealed.** Absent from the DOM, not hidden in it — a
 *    mounted `<video>` carrying a `src` is a fetch waiting for a heuristic.
 *  - **`preload="none"`.** Zero bytes cross the wire until the learner presses
 *    play. Even `metadata` costs a request and a range read per revealed card.
 *  - **No autoplay.** Watching is an explicit choice, which is also what makes
 *    the byte cost opt-in.
 *
 * Because the clip is resolved in the session's existing batch query, adding it
 * to a card costs no extra round trip on the request path either.
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
  const { src, poster, onError } = useClipUrlRecovery(clip);
  const durationSecs = Math.max(0, Math.round(clip.endSecs - clip.startSecs));

  return (
    <figure className="review-reveal my-3">
      <div className="rounded-lg overflow-hidden border border-[var(--md-outline-variant)] bg-black">
        <video
          src={src}
          poster={poster ?? undefined}
          onError={onError}
          controls
          playsInline
          preload="none"
          muted={clip.audioStripped}
          className="w-full h-auto max-h-[60vh] object-contain"
        />
      </div>
      {caption && (
        <figcaption className="mt-2 text-sm text-[var(--md-on-surface-variant)] leading-snug">
          {caption}
        </figcaption>
      )}
      <div className="mt-1.5 text-xs text-[var(--md-on-surface-variant)]">
        <a
          href={clip.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline text-[var(--md-primary)]"
        >
          {clip.sourceTitle}
        </a>
        <span> · {formatDuration(durationSecs)}</span>
      </div>
    </figure>
  );
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
