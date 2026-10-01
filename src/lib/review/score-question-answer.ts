import {
  gradeTypeX,
  missedStatementsForKType,
  responseFormatOfOptions,
  type StatementItemFormat,
} from '@/lib/question-bank/statement-items';

/**
 * Score one submitted answer against the options the learner was served.
 *
 * Single source of truth for the record path: the first scoring and the
 * locked-delivery re-check both call this, so a format cannot be scored one way
 * and verified another. Single best answer behaves exactly as it always has.
 * Statement items (see statement-items.ts) additionally return per-statement
 * feedback — which statements were missed, and the scaffold that teaches each —
 * when their Question.statements metadata is present.
 */

type OptionRow = { label: string; isCorrect: boolean };

export interface StatementMetadata {
  isTrue: boolean;
  correction: string | null;
  scaffoldTitle: string;
  scaffold: string;
}

export interface StatementFeedback {
  format: StatementItemFormat;
  marks: number;
  maxMarks: number;
  statements: Array<{
    isTrue: boolean;
    missed: boolean;
    correction: string | null;
    scaffoldTitle: string;
    scaffold: string;
  }>;
}

export type QuestionScore =
  | { ok: true; isCorrect: boolean; correctOption: string; statementFeedback?: StatementFeedback }
  | { ok: false; error: string };

function readStatements(raw: unknown): StatementMetadata[] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const rows = raw as Array<Partial<StatementMetadata>>;
  if (!rows.every((s) => typeof s?.isTrue === 'boolean' && typeof s.scaffold === 'string')) return null;
  return rows.map((s) => ({
    isTrue: s.isTrue as boolean,
    correction: typeof s.correction === 'string' ? s.correction : null,
    scaffoldTitle: typeof s.scaffoldTitle === 'string' ? s.scaffoldTitle : '',
    scaffold: s.scaffold as string,
  }));
}

function feedback(
  format: StatementItemFormat,
  statements: StatementMetadata[] | null,
  missed: number[],
  marks: number,
): StatementFeedback | undefined {
  if (!statements) return undefined;
  return {
    format,
    marks,
    maxMarks: 4,
    statements: statements.map((s, index) => ({ ...s, missed: missed.includes(index) })),
  };
}

export function scoreQuestionAnswer(
  options: OptionRow[],
  selectedOption: string | null,
  statementsRaw: unknown,
): QuestionScore {
  const format = responseFormatOfOptions(options);
  const statements = format === 'sba' ? null : readStatements(statementsRaw);

  if (format === 'typeX') {
    const correctOption = options.map((o) => (o.isCorrect ? 'T' : 'F')).join('');
    if (selectedOption === null) {
      const withFeedback = feedback('typeX', statements, [0, 1, 2, 3], 0);
      return { ok: true, isCorrect: false, correctOption, ...(withFeedback ? { statementFeedback: withFeedback } : {}) };
    }
    const grade = gradeTypeX(options, selectedOption);
    if (!grade) return { ok: false, error: 'Type X answer must be four T/F judgements' };
    const withFeedback = feedback('typeX', statements, grade.missed, grade.marks);
    return {
      ok: true,
      isCorrect: grade.isCorrect,
      correctOption: grade.correctOption,
      ...(withFeedback ? { statementFeedback: withFeedback } : {}),
    };
  }

  if (options.length < 4) return { ok: false, error: 'Question options are incomplete' };
  const correct = options.filter((o) => o.isCorrect);
  if (correct.length !== 1) return { ok: false, error: 'Question correct answer is invalid' };
  const correctOption = correct[0].label.trim().toUpperCase();
  const selected = selectedOption === null
    ? null
    : options.find((o) => o.label.trim().toUpperCase() === selectedOption.trim().toUpperCase());
  const isCorrect = selected?.isCorrect ?? false;

  if (format === 'kType') {
    const truths = statements?.map((s) => s.isTrue) ?? null;
    const missed = truths ? missedStatementsForKType(truths, selectedOption) : [];
    const withFeedback = feedback('kType', statements, missed, isCorrect ? 4 : 0);
    return { ok: true, isCorrect, correctOption, ...(withFeedback ? { statementFeedback: withFeedback } : {}) };
  }
  return { ok: true, isCorrect, correctOption };
}
