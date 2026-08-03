export default function ProfileLoading() {
  return (
    <div className="mx-auto max-w-2xl animate-pulse space-y-6 px-4 py-8">
      <div className="flex items-center gap-4">
        <div className="h-16 w-16 rounded-full bg-[var(--md-surface-variant)]" />
        <div className="flex-1 space-y-2">
          <div className="h-5 w-40 rounded bg-[var(--md-surface-variant)]" />
          <div className="h-3 w-56 rounded bg-[var(--md-surface-container)]" />
        </div>
        <div className="h-9 w-14 rounded-lg bg-[var(--md-surface-container)]" />
      </div>

      <div className="space-y-3">
        {[1, 2].map((item) => (
          <div
            key={item}
            className="h-16 rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)]"
          />
        ))}
      </div>
    </div>
  );
}
