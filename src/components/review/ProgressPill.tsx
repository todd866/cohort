'use client';

interface ProgressPillProps {
  reviewed: number;
  target: number | null;
  coveragePercent?: number | null;
  progress: number | null; // 0-100 fill percentage
  targetHit: boolean;
  bonusCount: number;
  onTap: () => void;
}

export function ProgressPill({
  reviewed,
  target,
  progress,
  targetHit,
  bonusCount,
  onTap,
}: ProgressPillProps) {
  const fillWidth = progress != null ? `${progress}%` : '0%';
  const hitColor = 'bg-green-500/10 dark:bg-green-400/15 border-green-500/40 dark:border-green-400/30';
  const activeColor = 'bg-[var(--md-primary-container)]/70 border-[var(--md-outline-soft)]';
  const fillColor = targetHit
    ? 'bg-green-500/25 dark:bg-green-400/20'
    : 'bg-[var(--md-primary)]/20';

  return (
    <button
      onClick={onTap}
      aria-label={targetHit ? `Target hit: ${target} done, ${bonusCount} bonus` : target != null ? `Progress: ${reviewed} of ${target}` : `${reviewed} reviewed`}
      className={`relative min-w-[72px] overflow-hidden rounded-full border px-3 py-1.5 text-xs font-medium transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.38)] ${
        targetHit ? hitColor : activeColor
      }`}
    >
      {/* Fill bar */}
      <div
        className={`absolute inset-y-0 left-0 ${fillColor} transition-all duration-500 ease-out`}
        style={{ width: fillWidth }}
      />

      {/* Text content */}
      <span className="relative flex items-center justify-center gap-1.5 text-[var(--md-on-surface)]">
        {targetHit ? (
          <>
            <span>{'\u2713'} {target} done</span>
            <span className="opacity-50">{'\u00b7'}</span>
            <span className="text-green-600 dark:text-green-400">+{bonusCount} bonus</span>
          </>
        ) : target != null ? (
          <span>{reviewed}/{target}</span>
        ) : (
          <span>{reviewed} reviewed</span>
        )}
      </span>
    </button>
  );
}
