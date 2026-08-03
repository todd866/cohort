'use client';

type SaveState = 'idle' | 'saving' | 'saved' | 'queued' | 'error';

// On-system colour ramp via design tokens (light + dark variants flip
// automatically), replacing raw Tailwind palette. Step 4 uses the defined
// primary blue rather than an undefined `blue-700` — completing the held DDR
// item ("no blue/info token defined; do that properly later").
const LEVELS = [
  { confidence: 1, color: 'var(--md-error)' },
  { confidence: 2, color: 'var(--md-warning)' },
  { confidence: 3, color: 'var(--md-success)' },
  { confidence: 4, color: 'var(--md-primary)' },
] as const;

const tint = (color: string) => `color-mix(in srgb, ${color} 14%, transparent)`;

interface ConfidenceButtonsProps {
  mode: 'inline' | 'footer';
  onSelect: (confidence: number) => void;
  selected?: number | null;
  status?: SaveState;
  wrapperRef?: React.Ref<HTMLDivElement>;
}

export function ConfidenceButtons({
  mode,
  onSelect,
  selected = null,
  status = 'idle',
  wrapperRef,
}: ConfidenceButtonsProps) {
  const disabled = status === 'saving' || status === 'saved' || status === 'queued';

  if (mode === 'footer') {
    return (
      <div
        ref={wrapperRef}
        className="fixed left-0 right-0 z-50 p-4 border-t border-[var(--md-outline-soft)] bg-[var(--md-surface)]/94 backdrop-blur shadow-[0_-10px_28px_rgba(21,35,46,0.08)] safe-area-pb"
        style={{ bottom: 'var(--md-review-footer-bottom, 0px)' }}
      >
        <div role="group" aria-label="How well did you know this?" className="max-w-2xl mx-auto flex gap-2">
          {LEVELS.map((level) => {
            const isSelected = selected === level.confidence;
            return (
              <button
                key={level.confidence}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(level.confidence)}
                aria-label={`Confidence ${level.confidence}`}
                className={`review-choice flex-1 py-3 rounded-lg border transition-colors font-medium text-sm ${
                  isSelected
                    ? 'border-current'
                    : 'border-[var(--md-outline-soft)] bg-[var(--md-surface-container-high)] hover:bg-[var(--md-surface-container-highest)]'
                } ${disabled && !isSelected ? 'opacity-40' : ''}`}
                style={{
                  color: level.color,
                  ...(isSelected ? { backgroundColor: tint(level.color) } : {}),
                }}
              >
                {level.confidence}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} role="group" aria-label="How well did you know this?" className="flex items-center gap-1.5 pt-2">
      {LEVELS.map((level) => {
        const isSelected = selected === level.confidence;
        return (
          <button
            key={level.confidence}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(level.confidence)}
            aria-label={`Confidence ${level.confidence}`}
            className={`review-choice min-w-[44px] min-h-[44px] px-2 rounded-md border text-sm font-medium transition-colors ${
              isSelected
                ? 'border-current'
                : 'border-transparent hover:bg-[var(--md-surface-container-high)] hover:border-[var(--md-outline-soft)]'
            } ${disabled && !isSelected ? 'opacity-40' : ''}`}
            style={
              isSelected
                ? { color: level.color, backgroundColor: tint(level.color) }
                : { color: 'color-mix(in srgb, var(--md-on-surface-variant) 55%, transparent)' }
            }
          >
            {level.confidence}
          </button>
        );
      })}
      {status === 'error' && (
        <span className="text-[10px] ml-1" style={{ color: 'var(--md-error)' }}>retry</span>
      )}
    </div>
  );
}
