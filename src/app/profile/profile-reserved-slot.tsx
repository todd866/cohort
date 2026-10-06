/**
 * The height a streaming section reserved, kept when the read is empty or failed.
 * Returning nothing under the placeholder collapses the slot.
 */
export function ProfileReservedSlot(
  { label, className, busy = false, message }:
  { label: string; className: string; busy?: boolean; message?: string },
) {
  return (
    <section aria-label={label} aria-busy={busy || undefined} className={`mb-6 ${className}`}>
      <div className="flex h-full w-full items-center justify-center rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-4">
        {message ? <p className="text-sm text-[var(--md-on-surface-variant)]">{message}</p> : null}
      </div>
    </section>
  );
}

export function ProfileSectionPlaceholder(
  { label, className }: { label: string; className: string },
) {
  return <ProfileReservedSlot label={label} className={className} busy />;
}
