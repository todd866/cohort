export type DifficultyLabel = 'easy' | 'medium' | 'hard';

export type DifficultySignals = {
  base: number;
  tokenLoad: number;
  numericLoad: number;
  uniqueness?: number;
};

export type DifficultyEstimate = {
  score: number;
  label: DifficultyLabel;
  signals: DifficultySignals;
};

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeLinear(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return 0;
  if (high <= low) return value >= high ? 1 : 0;
  return clamp01((value - low) / (high - low));
}

function countNumbers(text: string): number {
  const matches = text.match(/[-+]?\d+(?:\.\d+)?/g);
  return matches?.length ?? 0;
}

function countUnits(text: string): number {
  const matches = text.match(
    /\b(mg|mcg|g|mL|L|mmol|mmhg|bpm|°c|%|kg|cm|mm|hours?|mins?|minutes?|days?|weeks?)\b/gi
  );
  return matches?.length ?? 0;
}

export function difficultyLabelFromScore(score: number): DifficultyLabel {
  if (score >= 0.65) return 'hard';
  if (score >= 0.4) return 'medium';
  return 'easy';
}

export function deriveCardDifficulty(card: {
  cardType: 'cloze' | 'mcq';
  complexity: 1 | 2 | 3;
  front: string;
  back: string;
  context?: string | null;
  similarityAvgTopK?: number | null;
}): DifficultyEstimate {
  const baseByComplexity: Record<1 | 2 | 3, number> = { 1: 0.22, 2: 0.5, 3: 0.82 };
  const base = baseByComplexity[card.complexity] ?? 0.5;

  const fullText = [card.front, card.back, card.context ?? ''].filter(Boolean).join('\n\n');
  const tokenLoad = normalizeLinear(estimateTokens(fullText), 15, 140);
  const numericLoad = clamp01(
    0.7 * normalizeLinear(countNumbers(fullText), 0, 6) +
      0.3 * normalizeLinear(countUnits(fullText), 0, 6)
  );

  const signals: DifficultySignals = {
    base,
    tokenLoad,
    numericLoad,
  };

  // Optional manifold “uniqueness” signal: unique items tend to be harder to learn.
  const uniqueness =
    typeof card.similarityAvgTopK === 'number'
      ? clamp01(1 - card.similarityAvgTopK)
      : null;
  if (uniqueness !== null) {
    signals.uniqueness = uniqueness;
  }

  // Weighted mix (content-first, manifold-optional).
  let score = 0.6 * base + 0.25 * tokenLoad + 0.15 * numericLoad;
  if (uniqueness !== null) {
    score = clamp01(score + 0.15 * (uniqueness - 0.5));
  }

  return {
    score,
    label: difficultyLabelFromScore(score),
    signals,
  };
}

export function deriveQuestionDifficulty(question: {
  stem: string;
  options: Array<{ text: string }>;
  context?: string | null;
  questionType?: string | null;
  topics?: string[] | null;
  similarityAvgTopK?: number | null;
}): DifficultyEstimate {
  const type = (question.questionType ?? '').toLowerCase();
  const typeBase =
    type.includes('calculation') || type.includes('math')
      ? 0.78
      : type.includes('management') || type.includes('next-step') || type.includes('treatment')
        ? 0.72
        : type.includes('image')
          ? 0.7
          : type.includes('mechanism')
            ? 0.6
            : type.includes('diagnosis')
              ? 0.62
              : 0.55;

  const optionsText = question.options.map((o) => o.text).join('\n');
  const fullText = [question.stem, optionsText, question.context ?? ''].filter(Boolean).join('\n\n');

  const tokenLoad = normalizeLinear(estimateTokens(fullText), 25, 180);
  const numericLoad = clamp01(
    0.7 * normalizeLinear(countNumbers(fullText), 0, 10) +
      0.3 * normalizeLinear(countUnits(fullText), 0, 10)
  );

  // Topic breadth is a weak proxy for concept count when explicit concept links aren’t available.
  const topicBreadth = normalizeLinear((question.topics?.length ?? 0) || 0, 0, 6);

  const signals: DifficultySignals = {
    base: clamp01(typeBase + 0.08 * (topicBreadth - 0.5)),
    tokenLoad,
    numericLoad,
  };

  const uniqueness =
    typeof question.similarityAvgTopK === 'number'
      ? clamp01(1 - question.similarityAvgTopK)
      : null;
  if (uniqueness !== null) {
    signals.uniqueness = uniqueness;
  }

  let score = 0.55 * signals.base + 0.3 * tokenLoad + 0.15 * numericLoad;
  if (uniqueness !== null) {
    score = clamp01(score + 0.15 * (uniqueness - 0.5));
  }

  return {
    score,
    label: difficultyLabelFromScore(score),
    signals,
  };
}
