import type { PublicUsmleQuestion } from '@/lib/usmle/public-question-corpus.server';
import type { Step1HistoryRow } from '@/lib/usmle/step1-session.server';

export type CohortReviewChallengeLevel = -2 | -1 | 0 | 1 | 2;

const GAP_WINDOW_MS = 24 * 60 * 60 * 1_000;
const STRUCTURAL = new Set(['cohort', 'exam', 'usmle', 'step1', 'scaffold', 'gsse-scaffold', 'nsx-scaffold']);

export function isCohortClinicalTopic(topic: string): boolean {
  return topic.trim().length > 0 && topic.length <= 96
    && !/^(ladder|cohort|exam|usmle|step1):/i.test(topic)
    && !STRUCTURAL.has(topic.toLowerCase()) && !/[\u0000-\u001f\u007f]/.test(topic);
}

/** Public-only demonstrated gaps: recent incorrect answers and their authored tags. */
export function demonstratedCohortGapTopics(input: {
  questions: readonly PublicUsmleQuestion[];
  history: readonly Step1HistoryRow[];
  now: Date;
}): Set<string> {
  const byId = new Map(input.questions.map((question) => [question.id, question]));
  const cutoff = input.now.getTime() - GAP_WINDOW_MS;
  const topics = new Set<string>();
  const latest = new Map<string, Step1HistoryRow>();
  for (const row of input.history) {
    if (row.createdAt.getTime() >= cutoff && row.createdAt <= input.now
      && (!latest.has(row.questionId) || latest.get(row.questionId)!.createdAt <= row.createdAt)) {
      latest.set(row.questionId, row);
    }
  }
  for (const row of latest.values()) {
    if (row.isCorrect) continue;
    for (const topic of byId.get(row.questionId)?.topics ?? []) {
      if (isCohortClinicalTopic(topic)) topics.add(topic);
    }
  }
  return topics;
}

export function isCohortHardGapQuestion(input: {
  question: PublicUsmleQuestion;
  gapTopics: ReadonlySet<string>;
  answeredIds: ReadonlySet<string>;
}): boolean {
  return input.question.difficulty === 'hard'
    && !input.answeredIds.has(input.question.id)
    && input.question.topics.some((topic) => input.gapTopics.has(topic));
}

export function isCohortC1Scaffold(complexity: number | null | undefined): boolean {
  return complexity === 1;
}
