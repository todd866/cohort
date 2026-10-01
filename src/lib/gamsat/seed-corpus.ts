/**
 * Project the open GAMSAT corpus into the shape the curated question seeder
 * takes, so responses can be recorded against real `Question` rows.
 *
 * WHY THE STIMULUS IS NOT IN THE STEM. GAMSAT is one passage with six to eight
 * questions; `Question` is one row per question. Inlining the passage would
 * duplicate ~3 KB across every row and blow every stem-length detector in the
 * repo. Instead `sourceFile` points at the passage JSON — which is exactly what
 * that field is for, and what keeps `sourceFile: null` meaning "broken" — and
 * `topics` carries the passage id so questions from one stimulus are joinable.
 *
 * The DB row is the ITEM RECORD (identity, calibration, response anchor). The
 * shipped file corpus stays the RENDERING source.
 */
import type {
  CuratedQuestion,
  QuestionDifficulty,
  QuestionType,
} from '@/lib/question-bank/types';
import type { GamsatPassage } from './types';

/** Numeric S3 work is genuinely calculation; everything else is interpretation. */
const CALCULATION_MOVES = new Set([
  's3-intercept-extraction',
  's3-graph-gradient',
  's3-proportional-reasoning',
  's3-stoichiometric-ratio',
  's3-genetic-probability',
  's3-unit-dimension',
]);

export function questionTypeFor(moves: string[]): QuestionType {
  return moves.some((move) => CALCULATION_MOVES.has(move)) ? 'calculation' : 'interpretation';
}

export function difficultyFor(raw: string): QuestionDifficulty {
  const value = raw.trim().toLowerCase();
  if (value === 'easy' || value === 'hard') return value;
  return 'medium';
}

/**
 * Module nodes for one question.
 *
 * Move and domain deliberately live on separate axes — moves here, domain in
 * `topics` — so "accuracy on this move across domains" is a query rather than a
 * bespoke aggregation. That query IS the transfer measurement the taxonomy
 * needs, so the schema has to keep the axes apart.
 */
export function moduleNodesFor(passage: GamsatPassage, moves: string[]): string[] {
  return [
    'gamsat',
    `gamsat/${passage.section}`,
    ...moves.map((move) => `gamsat/move/${move}`),
  ];
}

export function passageSourceFile(passage: GamsatPassage): string {
  return `open-content/gamsat/passages/${passage.section}/${passage.domain}.v1.json`;
}

export function projectPassage(passage: GamsatPassage): CuratedQuestion[] {
  return passage.questions.map((question) => ({
    id: question.id,
    rotation: 'gamsat' as const,
    sourceFile: passageSourceFile(passage),
    moduleNodes: moduleNodesFor(passage, question.moves),
    topics: [
      passage.domain,
      // Joinable back to the stimulus without a passage table.
      `passage:${passage.id}`,
      ...question.moves.map((move) => `move:${move}`),
    ],
    questionType: questionTypeFor(question.moves),
    difficulty: difficultyFor(question.difficulty),
    stem: question.stem,
    options: question.options.map((option) => ({
      label: option.label,
      text: option.text,
      isCorrect: option.isCorrect,
      explanation: question.explanation,
    })),
    context: question.explanation,
    cite: null,
  }));
}

export interface GamsatSeedProjection {
  files: string[];
  questions: CuratedQuestion[];
  errors: string[];
}

/** Project the whole corpus, collecting rather than throwing on defects. */
export function projectCorpus(passages: GamsatPassage[]): GamsatSeedProjection {
  const errors: string[] = [];
  const questions: CuratedQuestion[] = [];
  const seen = new Set<string>();

  for (const passage of passages) {
    if (passage.questions.length === 0) {
      errors.push(`${passage.id}: passage has no questions`);
      continue;
    }
    for (const projected of projectPassage(passage)) {
      if (seen.has(projected.id)) {
        errors.push(`${projected.id}: duplicate question id`);
        continue;
      }
      seen.add(projected.id);

      const correct = projected.options.filter((option) => option.isCorrect);
      if (correct.length !== 1) {
        errors.push(`${projected.id}: expected exactly 1 correct option, found ${correct.length}`);
        continue;
      }
      // An untagged question is invisible to move-mastery, which is the entire
      // point of the corpus — refuse to seed one rather than record blind.
      if (!projected.moduleNodes?.some((node) => node.startsWith('gamsat/move/'))) {
        errors.push(`${projected.id}: no reasoning move tagged`);
        continue;
      }
      questions.push(projected);
    }
  }

  return {
    files: [...new Set(passages.map(passageSourceFile))].sort(),
    questions,
    errors,
  };
}
