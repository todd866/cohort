/**
 * Distractor Selection Statistics
 *
 * Aggregates QuestionResponse data to compute per-distractor selection rates.
 * Pure functions — no DB calls.
 */

export interface DistractorStat {
  selectionCount: number;
  selectionRate: number; // fraction of wrong-answer attempts
}

export interface ResponseRow {
  questionId: string;
  selectedOption: string;
  isCorrect: boolean;
}

/**
 * Aggregate raw QuestionResponse rows into per-option selection stats.
 * Only counts incorrect responses (distractors).
 *
 * Returns: Map<questionId, Map<optionLabel, DistractorStat>>
 */
export function aggregateDistractorSelections(
  responses: ResponseRow[]
): Map<string, Map<string, DistractorStat>> {
  const wrongByQuestion = new Map<string, string[]>();
  for (const r of responses) {
    if (r.isCorrect) continue;
    const list = wrongByQuestion.get(r.questionId) ?? [];
    list.push(r.selectedOption);
    wrongByQuestion.set(r.questionId, list);
  }

  const result = new Map<string, Map<string, DistractorStat>>();
  for (const [qId, wrongOptions] of wrongByQuestion) {
    const total = wrongOptions.length;
    const counts = new Map<string, number>();
    for (const opt of wrongOptions) {
      counts.set(opt, (counts.get(opt) ?? 0) + 1);
    }
    const stats = new Map<string, DistractorStat>();
    for (const [opt, count] of counts) {
      stats.set(opt, {
        selectionCount: count,
        selectionRate: total > 0 ? count / total : 0,
      });
    }
    result.set(qId, stats);
  }
  return result;
}

/**
 * Find distractors that are never selected ("dead").
 * Requires minAttempts wrong answers to be confident.
 */
export function findDeadDistractors(
  stats: Map<string, Map<string, DistractorStat>>,
  allOptions: Map<string, string[]>,
  minAttempts: number = 5
): Array<{ questionId: string; deadOptions: string[] }> {
  const results: Array<{ questionId: string; deadOptions: string[] }> = [];

  for (const [qId, labels] of allOptions) {
    const qStats = stats.get(qId);
    const totalWrong = qStats
      ? Array.from(qStats.values()).reduce((sum, s) => sum + s.selectionCount, 0)
      : 0;
    if (totalWrong < minAttempts) continue;

    const dead = labels.filter((label) => !qStats?.has(label));
    if (dead.length > 0) {
      results.push({ questionId: qId, deadOptions: dead });
    }
  }

  return results;
}
