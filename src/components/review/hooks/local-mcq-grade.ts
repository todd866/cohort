import { gradeTypeX, responseFormatOfOptions } from '@/lib/question-bank/statement-items';

type ShownOption = { label: string; isCorrect?: boolean; originalIndex?: number; statement?: true };

export interface LocalMcqGrade {
  isCorrect: boolean;
  /** Display label of the correct answer; for Type X the key string, e.g. 'TFFT'. */
  correctOption: string;
  /** Repeat-answer identity for this slot. */
  answerKey: string;
  /** What the server grades: the database label, or the Type X judgement string. */
  wireOption: string;
  correctDisplayPosition: number | undefined;
  selectedDisplayPosition: number | undefined;
}

/**
 * Grade an answer instantly from the options already on screen, the way the
 * review loop always has, and describe what to send to /api/study/record.
 * A Type X answer is four judgements ('TFFT'), not a position, so it carries
 * no display positions. Null means the answer is malformed — send nothing.
 */
export function localMcqGrade(options: ShownOption[], label: string): LocalMcqGrade | null {
  if (responseFormatOfOptions(options) === 'typeX') {
    const grade = gradeTypeX(options, label);
    if (!grade) return null;
    const wire = label.trim().toUpperCase();
    return {
      isCorrect: grade.isCorrect,
      correctOption: grade.correctOption,
      answerKey: `typex:${wire}`,
      wireOption: wire,
      correctDisplayPosition: undefined,
      selectedDisplayPosition: undefined,
    };
  }
  const selected = options.find((o) => o.label === label);
  return {
    isCorrect: selected?.isCorrect === true,
    correctOption: options.find((o) => o.isCorrect === true)?.label ?? '',
    answerKey: `option:${selected?.originalIndex ?? label}`,
    // Send the original DB label (not the shuffled display label) so the
    // server grades against the correct option in the database.
    wireOption: selected?.originalIndex != null ? String.fromCharCode(65 + selected.originalIndex) : label,
    correctDisplayPosition: options.findIndex((o) => o.isCorrect === true),
    selectedDisplayPosition: options.findIndex((o) => o.label === label),
  };
}
