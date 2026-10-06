export function ThumbIcon({ className, direction }: { className?: string; direction: 'up' | 'down' }) {
  return (
    <svg
      className={`${className ?? ''} ${direction === 'down' ? 'rotate-180' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 10v12H3V10h4Z" />
      <path d="M7 20h11.2a2 2 0 0 0 2-1.6l1.2-6A2 2 0 0 0 19.4 10H14l.8-4.1A3.3 3.3 0 0 0 11.6 2L7 10v10Z" />
    </svg>
  );
}
