// Shared MCQ icons - extracted from duplicated code across MCQ components.
// Each accepts an optional className (defaulting to the original w-6 h-6 so
// existing callers are unaffected) and is aria-hidden — they are decorative,
// always paired with text/state that conveys the same meaning.

type IconProps = { className?: string };

export function CheckIcon({ className = 'w-6 h-6' }: IconProps) {
  return (
    <svg className={className} aria-hidden="true" focusable="false" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

export function XIcon({ className = 'w-6 h-6' }: IconProps) {
  return (
    <svg className={className} aria-hidden="true" focusable="false" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

export function CheckCircleIcon({ className = 'w-6 h-6' }: IconProps) {
  return (
    <svg className={className} aria-hidden="true" focusable="false" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

export function XCircleIcon({ className = 'w-6 h-6' }: IconProps) {
  return (
    <svg className={className} aria-hidden="true" focusable="false" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

/**
 * Chevron for expanding per-option explanations. Lives in this shared leaf
 * module (not inside the heavy MCQ.client.tsx) so the review hot path can use
 * it without pulling that component's module graph into its bundle.
 */
export function ChevronIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
