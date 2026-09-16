/**
 * Patient Banner
 *
 * Top bar showing patient identity and key context.
 * Aviation principle: Primary identification always visible.
 */

import type { Demographics } from '@/lib/clinical-parser/types';

interface PatientBannerProps {
  demographics: Demographics;
  context: string[];
  timeline?: string; // "Day 4", "2 weeks ago"
}

export function PatientBanner({ demographics, context, timeline }: PatientBannerProps) {
  const ageDisplay = formatAge(demographics);
  const sexDisplay = demographics.sex !== 'unknown' ? demographics.sex : null;

  // No patient info = no banner
  if (!ageDisplay && !sexDisplay && context.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
      {/* Demographics chip */}
      {(ageDisplay || sexDisplay) && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] text-sm font-medium">
          {ageDisplay}
          {ageDisplay && sexDisplay && <span className="opacity-50">|</span>}
          {sexDisplay}
        </span>
      )}

      {/* Context chips */}
      {context.map((ctx, i) => (
        <span
          key={i}
          className="px-2 py-0.5 rounded-md bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)] text-sm"
        >
          {ctx}
        </span>
      ))}

      {/* Timeline if present */}
      {timeline && (
        <span className="px-2 py-0.5 rounded-md bg-[var(--md-tertiary-container)] text-[var(--md-on-tertiary-container)] text-sm">
          {timeline}
        </span>
      )}
    </div>
  );
}

function formatAge(demographics: Demographics): string | null {
  if (demographics.age === null) return null;

  const unit = demographics.ageUnit || 'years';
  const shortUnit: Record<string, string> = {
    years: 'y',
    months: 'mo',
    weeks: 'wk',
    days: 'd',
  };

  return `${demographics.age}${shortUnit[unit]}`;
}
