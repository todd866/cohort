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
  const hitColor = 'bg-[color-mix(in_srgb,var(--md-success)_12%,transparent)] border-[color-mix(in_srgb,var(--md-success)_40%,transparent)]';
  const activeColor = 'bg-[var(--md-primary-container)]/70 border-[var(--md-outline-soft)]';
  const fillColor = targetHit
    ? 'bg-[color-mix(in_srgb,var(--md-success)_22%,transparent)]'
    : 'bg-[var(--md-primary)]/20';

  return (
    <button
      onClick={onTap}
      aria-label={`${targetHit
        ? `Target hit: ${target} done, ${bonusCount} bonus`
        : target != null
          ? `Progress: ${reviewed} of ${target}`
          : `${reviewed} reviewed`}`}
      className={`relative shrink-0 whitespace-nowrap min-w-[72px] overflow-hidden rounded-full border px-3 py-1.5 text-xs font-medium transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.38)] ${
        targetHit ? hitColor : activeColor
      }`}
    >
      {/* Fill bar */}
      <div
        className={`absolute inset-y-0 left-0 ${fillColor}`}
        style={{ width: fillWidth }}
      />

      {/* Text content */}
      <span className="relative flex items-center justify-center gap-1.5 text-[var(--md-on-surface)]">
        {targetHit ? (
          <>
            {/* Phone width: the toolbar is one fixed row, so the done state
                collapses to "✓ +7"; the full sentence returns from `sm`. */}
            <span className="sm:hidden">
              {'\u2713'} <span className="text-[var(--md-success)]">+{bonusCount}</span>
            </span>
            <span className="hidden sm:inline">{'\u2713'} {target} done</span>
            <span className="hidden sm:inline opacity-50">{'\u00b7'}</span>
            <span className="hidden sm:inline text-[var(--md-success)]">+{bonusCount} bonus</span>
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
