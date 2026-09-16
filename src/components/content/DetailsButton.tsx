import Link from 'next/link';

interface DetailsButtonProps {
  type: 'card' | 'question';
  id: string;
  className?: string;
}

/**
 * Small info icon button that links to the details/talk page
 * for cards (/cards/[id]) or questions (/questions/[id]).
 * Matches ContentFlag.tsx pattern for consistent styling.
 */
export function DetailsButton({ type, id, className }: DetailsButtonProps) {
  const href = type === 'card' ? `/cards/${id}` : `/questions/${id}`;

  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener"
      aria-label={`View ${type} details`}
      title={`View ${type} details`}
      className={`p-1.5 rounded-md transition-colors text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)] ${className ?? ''}`}
    >
      <InfoIcon className="w-4 h-4" />
    </Link>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
