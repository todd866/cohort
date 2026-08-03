'use client';

interface ReviewToolbarProps {
  canGoBack: boolean;
  onBack: () => void;
}

export function ReviewToolbar({ canGoBack, onBack }: ReviewToolbarProps) {
  if (!canGoBack) return null;

  return (
    <div className="mb-3 text-xs text-[var(--md-on-surface-variant)]">
      <button
        onClick={onBack}
        className="px-2 py-1 rounded hover:bg-[var(--md-surface-container-high)] transition-colors"
        title="Go back (Z)"
      >
        {'\u2190'} back
      </button>
    </div>
  );
}
