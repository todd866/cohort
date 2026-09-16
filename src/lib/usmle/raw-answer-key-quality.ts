import type { CuratedQuestion } from '@/lib/question-bank/types';

export const STEP1_RAW_ANSWER_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;

export type Step1RawAnswerLabel = (typeof STEP1_RAW_ANSWER_LABELS)[number];

export type Step1RawAnswerKeyIssue =
  | {
      code: 'label-coverage';
      actual: number;
      required: number;
    }
  | {
      code: 'label-concentration';
      actualCount: number;
      actualShare: number;
      maximumShare: number;
    }
  | {
      code: 'label-streak';
      actual: number;
      maximum: number;
    };

export interface Step1RawAnswerKeyAudit {
  questionCount: number;
  representedLabelCount: number;
  maximumLabelCount: number;
  maximumLabelShare: number;
  longestSameLabelStreak: number;
  issues: Step1RawAnswerKeyIssue[];
}

/**
 * A deliberately lenient corpus-level floor for raw answer positions.
 *
 * Runtime Step 1 sessions shuffle options, but the FOSS JSON is also consumed
 * directly. Once a corpus is large enough to judge, no raw position should
 * hold more than twice the expected 20% share, disappear from a 20-item bank,
 * or repeat for more than five consecutive source items. None of these rules
 * dictates the answer position of an individual question.
 */
const MINIMUM_AUDIT_SIZE = 10;
const FULL_COVERAGE_SIZE = 20;
const MINIMUM_SMALL_CORPUS_COVERAGE = 4;
const MAXIMUM_LABEL_SHARE = 0.4;
const MAXIMUM_SAME_LABEL_STREAK = 5;

function isStep1RawAnswerLabel(label: string): label is Step1RawAnswerLabel {
  return (STEP1_RAW_ANSWER_LABELS as readonly string[]).includes(label);
}

function requiredLabelCoverage(questionCount: number): number {
  if (questionCount < MINIMUM_AUDIT_SIZE) return 0;
  return questionCount >= FULL_COVERAGE_SIZE
    ? STEP1_RAW_ANSWER_LABELS.length
    : MINIMUM_SMALL_CORPUS_COVERAGE;
}

export function auditStep1RawAnswerKey(
  questions: ReadonlyArray<Pick<CuratedQuestion, 'options'>>,
): Step1RawAnswerKeyAudit {
  const counts: Record<Step1RawAnswerLabel, number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
  };
  const labels: Step1RawAnswerLabel[] = [];

  questions.forEach((question, index) => {
    const correctOptions = question.options.filter((option) => option.isCorrect);
    if (correctOptions.length !== 1) {
      throw new Error(
        `question at index ${index} must have exactly one correct option to audit its raw answer key`,
      );
    }
    const label = correctOptions[0].label.trim().toUpperCase();
    if (!isStep1RawAnswerLabel(label)) {
      throw new Error(
        `question at index ${index} has unsupported raw correct label ${JSON.stringify(label)}; expected A-E`,
      );
    }
    counts[label] += 1;
    labels.push(label);
  });

  let longestSameLabelStreak = 0;
  let currentStreak = 0;
  let previousLabel: Step1RawAnswerLabel | null = null;
  for (const label of labels) {
    currentStreak = label === previousLabel ? currentStreak + 1 : 1;
    longestSameLabelStreak = Math.max(longestSameLabelStreak, currentStreak);
    previousLabel = label;
  }

  const questionCount = labels.length;
  const representedLabelCount = STEP1_RAW_ANSWER_LABELS.filter(
    (label) => counts[label] > 0,
  ).length;
  const maximumLabelCount = Math.max(0, ...Object.values(counts));
  const maximumLabelShare = questionCount === 0
    ? 0
    : maximumLabelCount / questionCount;
  const issues: Step1RawAnswerKeyIssue[] = [];

  const requiredCoverage = requiredLabelCoverage(questionCount);
  if (representedLabelCount < requiredCoverage) {
    issues.push({
      code: 'label-coverage',
      actual: representedLabelCount,
      required: requiredCoverage,
    });
  }
  if (
    questionCount >= MINIMUM_AUDIT_SIZE
    && maximumLabelCount > questionCount * MAXIMUM_LABEL_SHARE
  ) {
    issues.push({
      code: 'label-concentration',
      actualCount: maximumLabelCount,
      actualShare: maximumLabelShare,
      maximumShare: MAXIMUM_LABEL_SHARE,
    });
  }
  if (
    questionCount >= MINIMUM_AUDIT_SIZE
    && longestSameLabelStreak > MAXIMUM_SAME_LABEL_STREAK
  ) {
    issues.push({
      code: 'label-streak',
      actual: longestSameLabelStreak,
      maximum: MAXIMUM_SAME_LABEL_STREAK,
    });
  }

  return {
    questionCount,
    representedLabelCount,
    maximumLabelCount,
    maximumLabelShare,
    longestSameLabelStreak,
    issues,
  };
}

export function step1RawAnswerKeyFailureMessages(
  audit: Step1RawAnswerKeyAudit,
): string[] {
  return audit.issues.map((issue) => {
    switch (issue.code) {
      case 'label-coverage':
        return `raw answer key represents ${issue.actual}/${STEP1_RAW_ANSWER_LABELS.length} labels; ${issue.required} are required at this corpus size`;
      case 'label-concentration':
        return `raw answer key puts ${issue.actualCount}/${audit.questionCount} answers on one label; maximum share is ${Math.round(issue.maximumShare * 100)}%`;
      case 'label-streak':
        return `raw answer key has a ${issue.actual}-item same-label streak; maximum is ${issue.maximum}`;
    }
  });
}
