'use client';

// ── Shared types & constants ─────────────────────────────────

export interface EditForm {
  name: string;
  studyGoal: number;
  examDates: Record<string, string>;
  studying: string;
  year: string;
  school: string;
}

export const STUDYING_OPTIONS = ['Medicine', 'Nursing', 'Paramedics', 'Pre-med', 'Just browsing'];
export const YEAR_OPTIONS = ['Preclinical (Year 1-2)', 'Clinical (Year 3+)', 'Postgrad / Trainee', 'Other'];

// ── Re-exports from focused files ────────────────────────────

export { Accordion } from '@/components/ui/Accordion';
export { AppearanceSection, InstitutionModulesSection, EmailAliasesSection } from './profile-settings-sections';
export { SupportSection } from './profile-support';
