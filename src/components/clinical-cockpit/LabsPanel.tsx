/**
 * Labs Panel
 *
 * Lab results with reference ranges and flags.
 * Aviation principle: Alarm prioritization - critical first.
 */

import type { LabValue, Flag } from '@/lib/clinical-parser/types';
import { flagToSeverity } from '@/lib/clinical-parser';

interface LabsPanelProps {
  labs: LabValue[];
}

export function LabsPanel({ labs }: LabsPanelProps) {
  if (labs.length === 0) return null;

  // Sort: critical first, then abnormal, then normal
  const sortedLabs = [...labs].sort((a, b) => {
    const severityOrder = { critical: 0, abnormal: 1, normal: 2 };
    return severityOrder[flagToSeverity(a.flag)] - severityOrder[flagToSeverity(b.flag)];
  });

  return (
    <div className="flex flex-wrap gap-2">
      {sortedLabs.map((lab, i) => (
        <LabChip key={i} lab={lab} />
      ))}
    </div>
  );
}

function LabChip({ lab }: { lab: LabValue }) {
  const { bg, text, indicator } = getLabStyles(lab.flag);

  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ${bg}`}>
      <span className={`text-xs font-medium ${text} opacity-70`}>{lab.name}</span>
      <span className={`text-sm font-semibold ${text}`}>
        {lab.value !== null ? formatLabValue(lab.value, lab.unit) : '—'}
        {indicator && <span className="ml-0.5">{indicator}</span>}
      </span>
      {lab.referenceRange && lab.value !== null && (
        <span className="text-xs opacity-50">
          ({lab.referenceRange.low}-{lab.referenceRange.high})
        </span>
      )}
    </div>
  );
}

function getLabStyles(flag: Flag): { bg: string; text: string; indicator: string | null } {
  switch (flag) {
    case 'critical-high':
      return {
        bg: 'bg-red-500/20 border border-red-500/30',
        text: 'text-red-600 dark:text-red-400',
        indicator: '↑↑',
      };
    case 'critical-low':
      return {
        bg: 'bg-red-500/20 border border-red-500/30',
        text: 'text-red-600 dark:text-red-400',
        indicator: '↓↓',
      };
    case 'high':
      return {
        bg: 'bg-amber-500/15 border border-amber-500/25',
        text: 'text-amber-700 dark:text-amber-400',
        indicator: '↑',
      };
    case 'low':
      return {
        bg: 'bg-amber-500/15 border border-amber-500/25',
        text: 'text-amber-700 dark:text-amber-400',
        indicator: '↓',
      };
    default:
      return {
        bg: 'bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]',
        text: 'text-[var(--md-on-surface)]',
        indicator: null,
      };
  }
}

function formatLabValue(value: number, unit: string): string {
  // Format based on typical precision
  if (unit === 'g/L' || unit === 'μmol/L' || unit === 'umol/L') {
    return value.toString();
  }
  if (unit === 'mmol/L' || unit === 'ng/L' || unit === 'ng/mL') {
    return value.toFixed(1).replace(/\.0$/, '');
  }
  return value.toString();
}
