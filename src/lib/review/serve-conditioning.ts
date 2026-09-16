import { loadProximityOverlay, type ProximityOverlay } from '@/lib/manifold/card-question-proximity';
import type { NeighbourhoodEvidence, ReliabilityVerdict } from './grade-conditioner';
import { evidenceForCard } from './rating-reliability-pairs';
import type { RatingReliabilityRecord } from './rating-reliability-record';
import { parseGradeCalibration, type GradeCalibration } from './grade-calibration';

/**
 * What a served card carries to grade time.
 *
 * The conditioner runs on the grade path and may read no history there. So
 * everything it needs is assembled here, in the background, from two
 * precomputed inputs — the learner's reliability record (one row) and the
 * proximity overlay (a committed file) — and travels on the ServeDecision
 * payload exactly as predictedRecall does. The record handler already loads
 * that payload to echo predictedRecall; it reads this from the same row.
 */

export const SERVE_CONDITIONING_VERSION = 1 as const;

export interface ServeConditioning {
  version: typeof SERVE_CONDITIONING_VERSION;
  verdict: ReliabilityVerdict;
  /** Null when the card has no links at all; zero counts when it has links the learner has not answered. */
  evidence: NeighbourhoodEvidence | null;
  /** The learner's own quality → strength ladder, when they have enough pairs for one. */
  calibration: GradeCalibration | null;
  recordComputedAt: string;
}

/** Null when the learner has no record: the conditioner then passes through — today's behaviour. */
export function buildServeConditioning(
  record: RatingReliabilityRecord | null,
  overlay: ProximityOverlay | null,
  stableId: string | null | undefined,
): ServeConditioning | null {
  if (!record) return null;
  return {
    version: SERVE_CONDITIONING_VERSION,
    verdict: record.verdict,
    evidence: stableId ? evidenceForCard(overlay, stableId, record.questionOutcomes) : null,
    calibration: record.calibration,
    recordComputedAt: record.computedAt,
  };
}

const VERDICTS: ReadonlySet<string> = new Set(['trusted', 'insufficient-evidence', 'degenerate', 'uninformative']);

/** Reads it back off a ServeDecision payload; null for anything unexpected. */
export function parseServeConditioning(payload: unknown): ServeConditioning | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).conditioning;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (c.version !== SERVE_CONDITIONING_VERSION) return null;
  if (typeof c.verdict !== 'string' || !VERDICTS.has(c.verdict)) return null;
  const ev = c.evidence;
  let evidence: NeighbourhoodEvidence | null = null;
  if (ev && typeof ev === 'object' && !Array.isArray(ev)) {
    const e = ev as Record<string, unknown>;
    const count = (v: unknown) => {
      const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      return { n: Number(o.n ?? 0) || 0, correct: Number(o.correct ?? 0) || 0 };
    };
    evidence = { tight: count(e.tight), loose: count(e.loose) };
  }
  return {
    version: SERVE_CONDITIONING_VERSION,
    verdict: c.verdict as ReliabilityVerdict,
    evidence,
    calibration: parseGradeCalibration(c.calibration),
    recordComputedAt: String(c.recordComputedAt ?? ''),
  };
}

/**
 * Overlay per rotation, loaded once per process. The artifact is committed
 * content, so a deploy is the refresh; nothing here re-reads the file.
 */
const overlayCache = new Map<string, ProximityOverlay | null>();
export function proximityOverlayFor(rotation: string): ProximityOverlay | null {
  if (!overlayCache.has(rotation)) overlayCache.set(rotation, loadProximityOverlay(rotation));
  return overlayCache.get(rotation) ?? null;
}
