/**
 * ABG Panel
 *
 * Structured display for arterial/venous blood gas values.
 * Clinical format: pH | pCO₂ | pO₂ | HCO₃ | BE | Lactate
 *
 * Sources:
 * - University of Washington ABG Primer: standard order is pH/PCO2/PO2/HCO3
 * - Oxford Medical Education: vertical list with reference ranges
 */

import type { LabValue } from '@/lib/clinical-parser/types';
import { LAB_RANGES } from '@/lib/clinical-parser/reference-ranges';

// Map ABG key to reference range key
const ABG_RANGE_MAP: Record<string, keyof typeof LAB_RANGES> = {
  ph: 'ph',
  pco2: 'paco2',
  po2: 'pao2',
  hco3: 'bicarbonate',
  be: 'baseExcess',
  lactate: 'lactate',
};

function getRangeString(key: string): string | null {
  const rangeKey = ABG_RANGE_MAP[key];
  if (!rangeKey) return null;
  const range = LAB_RANGES[rangeKey];
  if (!range) return null;
  if (key === 'ph') return `${range.low.toFixed(2)}–${range.high.toFixed(2)}`;
  return `${range.low}–${range.high}`;
}

interface ABGPanelProps {
  labs: LabValue[];
  sampleType?: 'ABG' | 'VBG' | 'unknown';
  fiO2?: string; // e.g., "room air", "2L NC", "40%"
}

// ABG-related lab names (case-insensitive matching)
const ABG_LABS = ['ph', 'paco2', 'pco2', 'pao2', 'po2', 'hco3', 'bicarbonate', 'be', 'base excess', 'lactate'];

// Display order and labels
const ABG_ORDER: { key: string; label: string; subscript?: string }[] = [
  { key: 'ph', label: 'pH' },
  { key: 'pco2', label: 'pCO', subscript: '2' },
  { key: 'po2', label: 'pO', subscript: '2' },
  { key: 'hco3', label: 'HCO', subscript: '3' },
  { key: 'be', label: 'BE' },
  { key: 'lactate', label: 'Lac' },
];

// Normalize lab name for matching
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Check if a lab is an ABG value
export function isABGLab(lab: LabValue): boolean {
  const normalized = normalizeName(lab.name);
  return ABG_LABS.some(abg => normalized.includes(abg.replace(/[^a-z0-9]/g, '')));
}

// Map lab to ABG key
function getABGKey(lab: LabValue): string | null {
  const normalized = normalizeName(lab.name);

  if (normalized.includes('ph')) return 'ph';
  if (normalized.includes('paco2') || normalized.includes('pco2')) return 'pco2';
  if (normalized.includes('pao2') || normalized.includes('po2')) return 'po2';
  if (normalized.includes('hco3') || normalized.includes('bicarbonate') || normalized.includes('bicarb')) return 'hco3';
  if (normalized.includes('baseexcess') || normalized === 'be') return 'be';
  if (normalized.includes('lactate') || normalized.includes('lactic')) return 'lactate';

  return null;
}

// Get flag indicator and styles
function getFlagStyles(flag: LabValue['flag']): {
  indicator: string;
  textClass: string;
  bgClass: string;
} {
  switch (flag) {
    case 'critical-high':
      return {
        indicator: '↑↑',
        textClass: 'text-red-600 dark:text-red-400',
        bgClass: 'bg-red-500/20',
      };
    case 'critical-low':
      return {
        indicator: '↓↓',
        textClass: 'text-red-600 dark:text-red-400',
        bgClass: 'bg-red-500/20',
      };
    case 'high':
      return {
        indicator: '↑',
        textClass: 'text-amber-600 dark:text-amber-400',
        bgClass: 'bg-amber-500/15',
      };
    case 'low':
      return {
        indicator: '↓',
        textClass: 'text-amber-600 dark:text-amber-400',
        bgClass: 'bg-amber-500/15',
      };
    default:
      return {
        indicator: '',
        textClass: 'text-[var(--md-on-surface)]',
        bgClass: 'bg-[var(--md-surface-container)]',
      };
  }
}

// Format value with appropriate precision
function formatValue(value: number | null, key: string): string {
  if (value === null) return '—';

  switch (key) {
    case 'ph':
      return value.toFixed(2);
    case 'pco2':
    case 'po2':
    case 'hco3':
      return Math.round(value).toString();
    case 'be':
      // Show sign for BE
      const beVal = Math.round(value);
      return beVal > 0 ? `+${beVal}` : beVal.toString();
    case 'lactate':
      return value.toFixed(1);
    default:
      return value.toString();
  }
}

export function ABGPanel({ labs, sampleType = 'ABG', fiO2 }: ABGPanelProps) {
  // Build map of ABG values
  const abgMap = new Map<string, LabValue>();

  for (const lab of labs) {
    const key = getABGKey(lab);
    if (key) {
      abgMap.set(key, lab);
    }
  }

  // Only render if we have at least pH or pCO2
  if (!abgMap.has('ph') && !abgMap.has('pco2')) {
    return null;
  }

  // Filter to only show values we have
  const displayItems = ABG_ORDER.filter(item => abgMap.has(item.key));

  return (
    <div className="rounded-lg border border-[var(--md-outline-variant)] overflow-hidden">
      {/* Header */}
      <div className="px-3 py-1.5 bg-[var(--md-surface-container-high)] border-b border-[var(--md-outline-variant)] flex items-center gap-2">
        <span className="text-xs font-semibold text-[var(--md-on-surface-variant)] uppercase tracking-wide">
          {sampleType}
        </span>
        {fiO2 && (
          <span className="text-xs text-[var(--md-on-surface-variant)]">
            ({fiO2})
          </span>
        )}
      </div>

      {/* Values grid */}
      <div className="grid grid-cols-4 sm:grid-cols-6 divide-x divide-[var(--md-outline-variant)]">
        {displayItems.map(({ key, label, subscript }) => {
          const lab = abgMap.get(key)!;
          const { indicator, textClass, bgClass } = getFlagStyles(lab.flag);

          return (
            <div
              key={key}
              className={`px-2 py-2 text-center ${bgClass}`}
            >
              {/* Label */}
              <div className="text-xs text-[var(--md-on-surface-variant)] font-medium mb-0.5">
                {label}
                {subscript && <sub>{subscript}</sub>}
              </div>

              {/* Value */}
              <div className={`text-base font-semibold tabular-nums ${textClass}`}>
                {formatValue(lab.value, key)}
                {indicator && (
                  <span className="ml-0.5 text-sm">{indicator}</span>
                )}
              </div>

              {/* Unit (smaller, below) */}
              {lab.unit && (
                <div className="text-[10px] text-[var(--md-on-surface-variant)] opacity-60">
                  {lab.unit}
                </div>
              )}

              {/* Reference range */}
              {getRangeString(key) && (
                <div className="text-[9px] text-[var(--md-on-surface-variant)] opacity-40 mt-0.5">
                  {getRangeString(key)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Compact inline format for tight spaces: "7.44/20/102/13"
export function ABGInline({ labs }: { labs: LabValue[] }) {
  const abgMap = new Map<string, LabValue>();

  for (const lab of labs) {
    const key = getABGKey(lab);
    if (key) {
      abgMap.set(key, lab);
    }
  }

  const parts: string[] = [];

  for (const { key } of ABG_ORDER.slice(0, 4)) { // pH, pCO2, pO2, HCO3
    const lab = abgMap.get(key);
    if (lab?.value !== null && lab?.value !== undefined) {
      const { indicator } = getFlagStyles(lab.flag);
      parts.push(formatValue(lab.value, key) + indicator);
    }
  }

  if (parts.length === 0) return null;

  return (
    <code className="text-sm font-mono bg-[var(--md-surface-container)] px-2 py-0.5 rounded">
      {parts.join(' / ')}
    </code>
  );
}
