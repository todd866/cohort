import { prisma } from '@/lib/prisma';
import type { ReliabilityVerdict } from './grade-conditioner';
import type { QuestionOutcomes } from './rating-reliability-pairs';
import { parseGradeCalibration, type GradeCalibration } from './grade-calibration';

/**
 * The learner's reliability record: what the background refresh concluded,
 * stored on `User.feedProfile.ratingReliability` so nothing at serve or grade
 * time reads history. The user route spreads the existing feedProfile on
 * write, so this key survives profile saves.
 *
 * Reading it is one primary-key row read — a precomputed fact, not an
 * aggregation — which is why this module is not `.server` and the scheduler
 * may import it. Computing and writing it is `rating-reliability.server.ts`,
 * BACKGROUND USE ONLY.
 *
 * Absent or malformed → null, and the conditioner then passes the raw grade
 * through, which is today's behaviour. A missing record must never be an
 * outage.
 */

export const RATING_RELIABILITY_RECORD_VERSION = 1 as const;

export interface RatingReliabilityRecord {
  version: typeof RATING_RELIABILITY_RECORD_VERSION;
  computedAt: string;
  windowDays: number;
  /** Rotations whose proximity overlays contributed pairs. */
  rotations: string[];
  tier1: {
    grades: number;
    entropyBits: number;
    verdict: 'degenerate' | 'varied' | 'insufficient-evidence';
  };
  tier2: {
    pairs: number;
    auc: number | null;
    verdict: 'trusted' | 'uninformative' | 'insufficient-evidence';
  };
  verdict: ReliabilityVerdict;
  /** Skip-filtered per-question outcomes in the window — serve-time evidence. */
  questionOutcomes: QuestionOutcomes;
  /** The learner's own quality → strength ladder; null below the minimum pairs. */
  calibration: GradeCalibration | null;
}

export function parseRatingReliabilityRecord(value: unknown): RatingReliabilityRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const feed = value as Record<string, unknown>;
  const raw = feed.ratingReliability;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== RATING_RELIABILITY_RECORD_VERSION) return null;
  const verdict = r.verdict;
  if (
    verdict !== 'trusted' && verdict !== 'insufficient-evidence'
    && verdict !== 'degenerate' && verdict !== 'uninformative'
  ) return null;
  const outcomes = r.questionOutcomes;
  return {
    version: RATING_RELIABILITY_RECORD_VERSION,
    computedAt: String(r.computedAt ?? ''),
    windowDays: Number(r.windowDays ?? 0),
    rotations: Array.isArray(r.rotations) ? r.rotations.map(String) : [],
    tier1: (r.tier1 ?? { grades: 0, entropyBits: 0, verdict: 'insufficient-evidence' }) as RatingReliabilityRecord['tier1'],
    tier2: (r.tier2 ?? { pairs: 0, auc: null, verdict: 'insufficient-evidence' }) as RatingReliabilityRecord['tier2'],
    verdict,
    questionOutcomes: outcomes && typeof outcomes === 'object' && !Array.isArray(outcomes)
      ? (outcomes as QuestionOutcomes)
      : {},
    calibration: parseGradeCalibration(r.calibration),
  };
}

/** One PK read; any failure — including a mocked client without `user` — is null. */
export async function loadRatingReliabilityRecord(userId: string): Promise<RatingReliabilityRecord | null> {
  try {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { feedProfile: true } });
    return parseRatingReliabilityRecord(row?.feedProfile);
  } catch {
    return null;
  }
}
