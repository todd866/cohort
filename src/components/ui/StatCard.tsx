'use client';

export function StatCard({
  label,
  value,
  suffix,
  highlight,
  sublabel,
}: {
  label: string;
  value: number;
  suffix?: string;
  highlight?: boolean;
  sublabel?: string;
}) {
  return (
    <div
      className={`p-3 rounded-xl text-center ${
        highlight
          ? 'bg-[var(--md-error-container)]'
          : 'bg-[var(--md-surface-container)]'
      }`}
    >
      <div
        className={`text-xl font-bold ${
          highlight
            ? 'text-[var(--md-on-error-container)]'
            : 'text-[var(--md-on-surface)]'
        }`}
      >
        {value}
        <span className="text-sm font-normal text-[var(--md-on-surface-variant)]">
          {suffix}
        </span>
      </div>
      <div className="text-xs text-[var(--md-on-surface-variant)]">
        {label}
      </div>
      {sublabel && (
        <div className="text-[10px] text-[var(--md-on-surface-variant)] mt-0.5">
          {sublabel}
        </div>
      )}
    </div>
  );
}
