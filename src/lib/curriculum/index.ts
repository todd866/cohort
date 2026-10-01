import type {
  AssessmentPeriod,
  Block,
  CurriculumDefinition,
  CurriculumPosition,
  UpcomingExam,
  WeekDefinition,
} from './types';

export * from './types';

export function getCurriculum(_program: string): CurriculumDefinition | null {
  void _program;
  return null;
}

export function getCurriculumWeek(
  _program: string,
  _weekNumber: number,
): WeekDefinition | null {
  void _program;
  void _weekNumber;
  return null;
}

export function getAssessmentPeriod(
  _program: string,
  _date: Date,
): AssessmentPeriod | null {
  void _program;
  void _date;
  return null;
}

export function getUpcomingAssessments(
  _program: string,
  _date: Date,
): UpcomingExam[] {
  void _program;
  void _date;
  return [];
}

export function getBlockForWeek(
  _program: string,
  _weekNumber: number,
): Block | null {
  void _program;
  void _weekNumber;
  return null;
}

export function getCurriculumPosition(
  _program: string,
  _date: Date,
): CurriculumPosition | null {
  void _program;
  void _date;
  return null;
}

export function getWeekTopics(_program: string, _weekNumber: number): string[] {
  void _program;
  void _weekNumber;
  return [];
}

export function parseAnkiTagToCurriculum(_tag: string): {
  program: 'md1' | 'md2' | null;
  kat: number | null;
  block: string | null;
  type: string | null;
} {
  void _tag;
  return { program: null, kat: null, block: null, type: null };
}

export function getCurriculumModuleNodes(
  _program: 'md1' | 'md2',
  _kat: number | null,
  _block: string | null,
  _type: string | null,
): string[] {
  void _program;
  void _kat;
  void _block;
  void _type;
  return [];
}
