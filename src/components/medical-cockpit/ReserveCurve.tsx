'use client';

import { useMemo } from 'react';
import type { PatientState, Syndrome } from '@/lib/medical-cockpit';
import { getViabilityMargin } from '@/lib/medical-cockpit';
import { clamp } from '@/lib/utils/clamp';

export interface ReserveCurveProps {
  syndrome: Syndrome;
  state: PatientState;
  previewState?: PatientState | null;
}

export function ReserveCurve({ syndrome, state, previewState = null }: ReserveCurveProps) {
  const { points, current, knee, preview } = useMemo(() => {
    const samples = 120;
    const values: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < samples; i++) {
      const reserve = i / (samples - 1);
      const margin = getViabilityMargin({ ...state, reserve }, syndrome);
      values.push({ x: reserve, y: clamp(margin, 0, 1) });
    }

    return {
      points: values,
      current: {
        x: clamp(state.reserve, 0, 1),
        y: clamp(getViabilityMargin(state, syndrome), 0, 1),
      },
      preview: previewState
        ? {
            x: clamp(previewState.reserve, 0, 1),
            y: clamp(getViabilityMargin(previewState, syndrome), 0, 1),
          }
        : null,
      knee: syndrome === 'paeds_hemorrhage' ? 0.3 : null,
    };
  }, [syndrome, state, previewState]);

  const width = 320;
  const height = 140;
  const padding = 16;

  const xToPx = (x: number) => padding + x * (width - 2 * padding);
  const yToPx = (y: number) => height - padding - y * (height - 2 * padding);

  const path = points
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xToPx(p.x).toFixed(2)} ${yToPx(p.y).toFixed(2)}`)
    .join(' ');

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-[var(--md-on-surface)]">
          Reserve Curve
        </div>
        <div className="text-xs text-[var(--md-on-surface-variant)]">
          M(x) vs reserve
        </div>
      </div>

      <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto"
          role="img"
          aria-label="Reserve curve showing viability margin versus reserve"
        >
          {/* Axes */}
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(255,255,255,0.25)" />
          <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="rgba(255,255,255,0.25)" />

          {/* Knee marker */}
          {typeof knee === 'number' && (
            <line
              x1={xToPx(knee)}
              y1={padding}
              x2={xToPx(knee)}
              y2={height - padding}
              stroke="rgba(255,255,255,0.35)"
              strokeDasharray="4 4"
            />
          )}

          {/* Curve */}
          <path
            d={path}
            fill="none"
            stroke="rgba(255,255,255,0.9)"
            strokeWidth="2"
          />

          {/* Current point */}
          <circle cx={xToPx(current.x)} cy={yToPx(current.y)} r="4" fill="white" />

          {/* Preview point */}
          {preview && (
            <>
              <line
                x1={xToPx(current.x)}
                y1={yToPx(current.y)}
                x2={xToPx(preview.x)}
                y2={yToPx(preview.y)}
                stroke="rgba(255,255,255,0.55)"
                strokeDasharray="3 3"
              />
              <circle
                cx={xToPx(preview.x)}
                cy={yToPx(preview.y)}
                r="4.5"
                fill="none"
                stroke="var(--md-tertiary)"
                strokeWidth="2"
              />
            </>
          )}

          {/* Labels */}
          <text x={padding} y={12} fontSize="10" fill="rgba(255,255,255,0.7)">
            Margin
          </text>
          <text x={width - padding - 40} y={height - 6} fontSize="10" fill="rgba(255,255,255,0.7)">
            Reserve
          </text>
        </svg>

        <div className="mt-2 flex items-center justify-between text-xs text-[var(--md-on-surface-variant)]">
          <span>Reserve: {current.x.toFixed(2)}</span>
          <span>Margin: {current.y.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
