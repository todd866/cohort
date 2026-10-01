'use client';

interface AudioViewProps {
  /** Resolved audio URL (R2-signed for copyright-tier clips). */
  audioUrl: string;
  /** The prompt text (e.g. "Listen at the apex and name the sound"). */
  prompt?: string;
  /** Answer revealed → show the sound name. */
  revealed: boolean;
  /** The answer (sound name, e.g. "normal heart sounds"), shown only post-reveal. */
  answer?: string;
}

/**
 * Audio card renderer — the AnKing heart-sound/murmur "identify this sound"
 * cards. The clip is the PROMPT (the student listens and recalls the sound
 * name), so the player is shown from the start and the answer stays hidden
 * until reveal (the answer text would otherwise give the recognition away).
 * Uses the native <audio controls> player (cross-browser, accessible).
 */
export function AudioView({ audioUrl, prompt, revealed, answer }: AudioViewProps) {
  return (
    <div className="text-[var(--md-on-surface)]">
      {prompt && <div className="mb-3 text-[1.03rem] leading-relaxed">{prompt}</div>}
      <audio
        controls
        preload="none"
        src={audioUrl}
        aria-label="Listen and identify the sound"
        className="w-full"
      >
        Your browser does not support audio playback.
      </audio>
      {revealed && answer && (
        <div className="mt-3 p-3.5 rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]">
          {answer}
        </div>
      )}
    </div>
  );
}
