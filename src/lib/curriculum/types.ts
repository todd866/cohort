/**
 * Curriculum mapping types for MD1/MD2 programs
 *
 * Maps academic calendar → blocks → weeks → topics → cards
 * Supports multiple assessment types per period (KAT, AHCT, MMCA)
 */

export type AssessmentType = 'kat' | 'ahct' | 'mmca';

export interface Assessment {
  type: AssessmentType;
  id: string;
  name: string;
  weight: number; // Relative importance for scheduling
}

export interface AssessmentPeriod {
  id: string;
  name: string;
  examDate: string; // ISO date string
  assessments: Assessment[];
  blocks: string[]; // Block IDs covered in this period
}

export interface Block {
  id: string;
  name: string;
  weeks: number[]; // Academic year week numbers (1-indexed)
  topics: string[]; // Topic slugs for card matching
}

export interface ContinuousTrack {
  id: string;
  name: string;
  assessments: string[]; // Assessment IDs across the year
  regions?: string[]; // For anatomy: body regions
  topics?: string[]; // For clinical skills: skill topics
}

export interface WeekDefinition {
  number: number; // Academic year week (1-indexed)
  block: string; // Block ID
  title: string; // Week title/focus
  topics: string[]; // Topic slugs for this week
  learningObjectives?: string[]; // Optional LOs
}

export interface CurriculumDefinition {
  institution: string;
  program: 'md1' | 'md2' | 'md3';
  cohort: number;
  startDate: string; // ISO date string
  assessmentPeriods: AssessmentPeriod[];
  blocks: Block[];
  continuousTracks: ContinuousTrack[];
  weeks: WeekDefinition[];
}

export interface CurriculumPosition {
  program: 'md1' | 'md2' | 'md3';
  currentWeek: number;
  currentBlock: string;
  blockName: string;
  weekTitle: string;
  upcomingExams: UpcomingExam[];
  continuousTracks: TrackProgress[];
}

export interface UpcomingExam {
  id: string;
  name: string;
  type: AssessmentType;
  date: string;
  daysUntil: number;
}

export interface TrackProgress {
  id: string;
  name: string;
  progress: number; // 0-1
}
