export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2.5 py-2 rounded-lg bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
      <div className="text-[10px] uppercase tracking-wide text-[var(--md-on-surface-variant)]">
        {label}
      </div>
      <div className="text-sm font-semibold text-[var(--md-on-surface)]">
        {value}
      </div>
    </div>
  );
}
