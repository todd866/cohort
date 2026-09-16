'use client';

type SaveState = 'idle' | 'saving' | 'saved' | 'queued' | 'error';

// On-system colour ramp via design tokens (light + dark variants flip
// automatically), replacing raw Tailwind palette. Step 4 uses the defined
// primary blue rather than an undefined `blue-700` — completing the held DDR
// item ("no blue/info token defined; do that properly later").
/**
 * What each step MEANS, in words.
 *
 * These buttons used to render bare digits 1-4 under the heading "How well did
 * you know this?", which is ambiguous in the worst possible way: under that
 * question "1" reads as best to some people and worst to others. It showed in
 * the data — of four active learners, three graded 57-70% of every card
 * "Again" and the fourth graded 0%, a spread that says more about the control
 * than about anyone's memory. And the consequence is not cosmetic: this is the
 * only input to the scheduler's memory model, so a learner pressing the wrong
 * end pins their stability at its floor and every downstream estimate with it.
 *
 * The wording is Anki's, deliberately — it is the vocabulary a medical student
 * arriving here has already met, and it answers the question the scheduler is
 * actually asking: when do you want to see this again?
 */
export const CONFIDENCE_LABELS: Record<number, string> = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
};

/**
 * The group's accessible name, and the per-button one.
 *
 * EXPORTED because e2e specs assert on them. When these were literals, renaming
 * the group label passed every unit test and typecheck and broke six Playwright
 * specs that hard-coded the old string — `npm run test:run` does not run
 * Playwright, so nothing local could see it (see
 * .claude/rules/pre-push-gate-is-weaker-than-the-release.md). Importing them
 * makes the next rename a compile error instead of a CI cycle.
 */
export const CONFIDENCE_GROUP_LABEL = 'When do you want to see this again?';

export function confidenceButtonName(confidence: number): string {
  return `${CONFIDENCE_LABELS[confidence]} (${confidence})`;
}

const GROUP_LABEL = CONFIDENCE_GROUP_LABEL;

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
        className="fixed left-0 right-0 md:left-20 z-50 p-4 border-t border-[var(--md-outline-soft)] bg-[var(--md-surface)]/94 backdrop-blur shadow-[0_-10px_28px_rgba(21,35,46,0.08)] safe-area-pb"
        style={{ bottom: 'var(--md-review-footer-bottom, 0px)' }}
      >
        <div role="group" aria-label={GROUP_LABEL} className="max-w-2xl mx-auto flex gap-2">
          {LEVELS.map((level) => {
            const isSelected = selected === level.confidence;
            return (
              <button
                key={level.confidence}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(level.confidence)}
                aria-label={confidenceButtonName(level.confidence)}
                className={`review-choice flex-1 py-2.5 rounded-lg border transition-colors font-medium text-sm ${
                  isSelected
                    ? 'border-current'
                    : 'border-[var(--md-outline-soft)] bg-[var(--md-surface-container-high)] hover:bg-[var(--md-surface-container-highest)]'
                } ${disabled && !isSelected ? 'opacity-40' : ''}`}
                style={{
                  color: level.color,
                  ...(isSelected ? { backgroundColor: tint(level.color) } : {}),
                }}
              >
                <span className="block leading-tight">{CONFIDENCE_LABELS[level.confidence]}</span>
                <span className="block text-[10px] leading-tight opacity-60 tabular-nums">
                  {level.confidence}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} role="group" aria-label={GROUP_LABEL} className="flex items-center gap-1.5 pt-2">
      {LEVELS.map((level) => {
        const isSelected = selected === level.confidence;
        return (
          <button
            key={level.confidence}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(level.confidence)}
            aria-label={confidenceButtonName(level.confidence)}
            className={`review-choice min-w-[44px] min-h-[44px] px-2 rounded-md border text-xs font-medium transition-colors ${
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
            {CONFIDENCE_LABELS[level.confidence]}
          </button>
        );
      })}
      {status === 'error' && (
        <span className="text-[10px] ml-1" style={{ color: 'var(--md-error)' }}>retry</span>
      )}
    </div>
  );
}
