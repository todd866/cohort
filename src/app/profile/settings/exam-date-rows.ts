import { isMd1Program, MD1_EXAMS } from '@/lib/md1-program';
import { ROTATIONS, defaultExamDateFor } from '@/lib/rotations';

export interface ExamDateRow {
  id: string;
  shortName: string;
  /** YYYY-MM-DD, or '' when no date is on file. */
  examDate: string;
}

/**
 * The exam-date rows Settings offers. A first-year dates KAT4 and the MMCA
 * themselves (no MD1 calendar is on file, so nothing is prefilled); everyone
 * else edits the Year 3 blocks, prefilled from the block calendar.
 */
export function examDateRows(
  institution: string | null | undefined,
  personal: ReadonlyMap<string, Date | null>,
  /** The learner's stream: block defaults are their own exams, not Track 3's. */
  track: number | null = null,
): ExamDateRow[] {
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  if (isMd1Program(institution)) {
    return MD1_EXAMS.map((exam) => {
      const date = personal.get(exam.id);
      return { id: exam.id, shortName: exam.short, examDate: date ? iso(date) : '' };
    });
  }
  return ROTATIONS.map((rotation) => ({
    id: rotation.id,
    shortName: rotation.shortName,
    examDate: iso(personal.get(rotation.id) ?? defaultExamDateFor(rotation.id, track) ?? rotation.defaultExamDate),
  }));
}
