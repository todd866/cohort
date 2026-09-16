import { linksForCard, type ProximityOverlay } from '@/lib/manifold/card-question-proximity';
import type { GradeOutcomePair } from './rating-discrimination';
import type { EvidenceCount, NeighbourhoodEvidence } from './grade-conditioner';

/**
 * The pure core of the background reliability refresh.
 *
 * Three transforms over a learner's raw history and the proximity overlay:
 *
 *   summariseQuestionOutcomes  attempts → per-question {n, correct}, skips
 *                              excluded. Stored on the learner's reliability
 *                              record so serve time can build neighbourhood
 *                              evidence for a card with no history read.
 *   evidenceForCard            a card's linked outcomes split tight/loose —
 *                              what the served item carries to grade time.
 *   pairGradesWithOutcomes     (grade, correct) pairs for the tier-2 AUC:
 *                              each cloze grade against the learner's answered
 *                              attempts on the card's TIGHT links within a
 *                              window. Loose links are the same topic, not a
 *                              probe of the fact, and are not pairs.
 *
 * Skips are excluded everywhere. A skip is stored as isCorrect false and was
 * 42% of all recorded wrong answers when measured; counting it makes every
 * distrusted rater look worse than they are, by a margin that scales with
 * how much they study.
 *
 * Nothing here touches the database; the .server module feeds it.
 */

export interface QuestionAttempt {
  questionId: string;
  correct: boolean;
  skipped: boolean;
  at: Date;
}

export interface CardGradeEvent {
  stableId: string;
  quality: number;
  at: Date;
}

export type QuestionOutcomes = Record<string, EvidenceCount>;

export function summariseQuestionOutcomes(attempts: readonly QuestionAttempt[]): QuestionOutcomes {
  const out: QuestionOutcomes = {};
  for (const a of attempts) {
    if (a.skipped) continue;
    const cell = out[a.questionId] ?? { n: 0, correct: 0 };
    cell.n += 1;
    if (a.correct) cell.correct += 1;
    out[a.questionId] = cell;
  }
  return out;
}

/**
 * Null when the card has no links at all — the neighbourhood is silent and
 * the conditioner should say so. Zero counts when links exist but the learner
 * has answered none of them: that is "no evidence yet", a different state.
 */
export function evidenceForCard(
  overlay: ProximityOverlay | null,
  stableId: string,
  outcomes: QuestionOutcomes,
): NeighbourhoodEvidence | null {
  const { tight, loose } = linksForCard(overlay, stableId);
  if (tight.length === 0 && loose.length === 0) return null;
  const sum = (links: ReadonlyArray<{ q: string }>): EvidenceCount => {
    const acc = { n: 0, correct: 0 };
    for (const l of links) {
      const o = outcomes[l.q];
      if (!o) continue;
      acc.n += o.n;
      acc.correct += o.correct;
    }
    return acc;
  };
  return { tight: sum(tight), loose: sum(loose) };
}

export const PAIR_WINDOW_DAYS = 14;

export function pairGradesWithOutcomes(
  overlay: ProximityOverlay | null,
  grades: readonly CardGradeEvent[],
  attempts: readonly QuestionAttempt[],
  { windowDays = PAIR_WINDOW_DAYS }: { windowDays?: number } = {},
): GradeOutcomePair[] {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const answeredByQuestion = new Map<string, QuestionAttempt[]>();
  for (const a of attempts) {
    if (a.skipped) continue;
    const list = answeredByQuestion.get(a.questionId) ?? [];
    list.push(a);
    answeredByQuestion.set(a.questionId, list);
  }
  const pairs: GradeOutcomePair[] = [];
  for (const g of grades) {
    const { tight } = linksForCard(overlay, g.stableId);
    for (const link of tight) {
      for (const a of answeredByQuestion.get(link.q) ?? []) {
        if (Math.abs(a.at.getTime() - g.at.getTime()) <= windowMs) {
          pairs.push({ grade: g.quality, correct: a.correct });
        }
      }
    }
  }
  return pairs;
}
