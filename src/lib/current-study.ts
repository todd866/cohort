import type { RotationConfig } from './rotations';

export interface CurrentStudyContext {
  rotation: RotationConfig;
  rotationId: string;
  week: number;
  daysUntilExam: number;
  isExamWeek: boolean;
  blockNumber: number;
  blockName: string;
}

export function getCurrentStudyContext(
  _date: Date = new Date(),
  _track: number = 1,
): CurrentStudyContext | null {
  void _date;
  void _track;
  return null;
}
