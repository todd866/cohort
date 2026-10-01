'use client';

interface HeatFieldChartProps {
  rotation: string;
}

export function HeatFieldChart({ rotation }: HeatFieldChartProps) {
  return (
    <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-4">
      <p className="text-sm text-[var(--md-on-surface-variant)]">
        Heat field chart is unavailable in this build for <span className="font-mono">{rotation}</span>.
      </p>
    </div>
  );
}
