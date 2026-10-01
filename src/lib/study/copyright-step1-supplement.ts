import { QUESTION_REINFORCEMENT_SOURCE_COMPONENT } from '@/lib/usmle/raw-reinforcement-card-boundary';
import {
  USMLE_STEP1_OPEN_ROTATION,
  USMLE_STEP1_PRIMARY_ROTATION,
} from '@/lib/usmle/raw-question-boundary';
import type { UnifiedItem } from '@/lib/study/unified-session-types';

const CARD_LIMIT = 4;
const QUESTION_LIMIT = 2;

export function mayIncludeCopyrightStep1(
  imageTier: string,
  publicSurface: string | undefined,
): boolean {
  return imageTier === 'copyright' && publicSurface !== 'cohort';
}

export function copyrightStep1CardItem(card: {
  id: string;
  front: string;
  back: string;
  context?: string | null;
  topics?: string[];
}): UnifiedItem {
  return {
    type: 'card',
    id: card.id,
    front: card.front,
    back: card.back,
    context: card.context ?? null,
    topics: card.topics ?? [],
    rotation: USMLE_STEP1_OPEN_ROTATION,
    week: null,
    servedBy: 'focused',
  };
}

export function copyrightStep1QuestionItem(question: {
  id: string;
  stem: string;
  context?: string | null;
  difficulty?: string | null;
  topics?: string[];
  options: unknown;
}): UnifiedItem {
  const options = Array.isArray(question.options)
    ? question.options.flatMap((option) => {
        if (!option || typeof option !== 'object') return [];
        const row = option as { label?: unknown; text?: unknown; isCorrect?: unknown };
        if (typeof row.label !== 'string' || typeof row.text !== 'string') return [];
        if (typeof row.isCorrect !== 'boolean') return [];
        return [{ label: row.label, text: row.text, isCorrect: row.isCorrect }];
      })
    : [];
  return {
    type: 'question',
    id: question.id,
    stem: question.stem,
    context: question.context ?? null,
    options,
    difficulty: question.difficulty ?? undefined,
    topics: question.topics ?? [],
    rotation: USMLE_STEP1_OPEN_ROTATION,
    week: null,
    servedBy: 'focused',
  };
}

export interface CopyrightStep1Store {
  cards: Array<{
    id: string;
    front: string;
    back: string;
    context: string | null;
    topics: string[];
  }>;
  questions: Array<{
    id: string;
    stem: string;
    context: string | null;
    difficulty: string | null;
    topics: string[];
    options: unknown;
  }>;
}

function windowStart(length: number, limit: number, seed: string): number {
  if (length <= limit) return 0;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 33 + seed.charCodeAt(i)) >>> 0;
  return hash % (length - limit + 1);
}

export async function loadCopyrightStep1Supplement(args: {
  imageTier: string;
  publicSurface: string | undefined;
  excludeCardIds: ReadonlySet<string>;
  seed: string;
  load: () => Promise<CopyrightStep1Store>;
}): Promise<UnifiedItem[]> {
  if (!mayIncludeCopyrightStep1(args.imageTier, args.publicSurface)) return [];
  const store = await args.load();
  const cards = store.cards.filter((card) => !args.excludeCardIds.has(card.id));
  const cardStart = windowStart(cards.length, CARD_LIMIT, `${args.seed}:cards`);
  const questionStart = windowStart(store.questions.length, QUESTION_LIMIT, `${args.seed}:questions`);
  return [
    ...cards.slice(cardStart, cardStart + CARD_LIMIT).map(copyrightStep1CardItem),
    ...store.questions.slice(questionStart, questionStart + QUESTION_LIMIT).map(copyrightStep1QuestionItem),
  ];
}

export const COPYRIGHT_STEP1_CARD_WHERE = {
  rotation: USMLE_STEP1_PRIMARY_ROTATION,
  NOT: { sourceComponent: QUESTION_REINFORCEMENT_SOURCE_COMPONENT },
} as const;
