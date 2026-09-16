/**
 * Shared skeleton for route-level loading boundaries.
 *
 * Why these exist at all: in the App Router a route WITHOUT a loading.tsx
 * blocks the navigation — the previous page stays frozen on screen until the
 * server component fully resolves, then swaps. With one, the transition is
 * immediate and content streams in. Every md3 route is dynamic (auth() opts
 * out of static rendering), so each tab switch is a server round-trip and this
 * boundary is the difference between "instant" and "stuck".
 *
 * the reference learner, 2026-07-25: "I don't mind if the initial load is slow, but after that it
 * should be near-instant to swap between tabs."
 */
export function RouteSkeleton({
  title,
  rows = 6,
  wide = false,
}: {
  title?: string;
  rows?: number;
  wide?: boolean;
}) {
  return (
    <main
      className={`mx-auto ${wide ? 'max-w-3xl' : 'max-w-2xl'} px-5 py-6 pb-28 md:pb-10`}
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading{title ? ` ${title}` : ''}…</span>
      {title && (
        <div className="mb-7">
          <div className="h-7 w-48 rounded bg-[var(--md-surface-container-high)]" />
          <div className="mt-2 h-4 w-64 rounded bg-[var(--md-surface-container-high)] opacity-70" />
        </div>
      )}
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-4"
          >
            <div className="h-4 w-2/3 rounded bg-[var(--md-surface-container-high)]" />
            <div className="mt-2 h-3 w-1/2 rounded bg-[var(--md-surface-container-high)] opacity-70" />
          </div>
        ))}
      </div>
    </main>
  );
}
