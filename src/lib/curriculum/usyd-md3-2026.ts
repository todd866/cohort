import type { CurriculumDefinition } from './types';

export function md3TeachingWeekFor(_block: string, _topic: string): number | null {
  void _block;
  void _topic;
  return null;
}

export function md3TopicsTaughtBy(_block: string, _week: number): string[] {
  void _block;
  void _week;
  return [];
}

export const USYD_MD3_2026: CurriculumDefinition = {
  institution: 'public',
  program: 'md3',
  cohort: 0,
  startDate: '1970-01-01',
  assessmentPeriods: [],
  blocks: [],
  continuousTracks: [],
  weeks: [],
};
