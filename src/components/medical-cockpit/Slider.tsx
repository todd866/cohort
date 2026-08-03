export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  format,
}: SliderProps) {
  const display = format ? format(value) : Number.isFinite(value) ? value.toFixed(0) : '—';
  return (
    <label className="block">
      <div className="flex items-center justify-between text-xs text-[var(--md-on-surface-variant)] mb-1">
        <span>{label}</span>
        <span className="font-medium text-[var(--md-on-surface)]">
          {display}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </label>
  );
}
