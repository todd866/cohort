export interface ItemTargetIndexInput {
  effectiveDomainWeight: number;
  maxDomainWeight: number;
  fitPercentile: number | null;
  geometryConfidence: number;
  assignmentConfidence: number;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Static, target-relative content score. Presence of the input means the item
 * has an explicit row for this target; a missing row remains `null` so callers
 * cannot mistake missing evidence for low relevance.
 */
export function computeItemTargetIndex(
  input: ItemTargetIndexInput | null,
): number | null {
  if (!input) return null;
  if (
    !Number.isFinite(input.effectiveDomainWeight)
    || !Number.isFinite(input.maxDomainWeight)
    || input.maxDomainWeight <= 0
    || !Number.isFinite(input.geometryConfidence)
    || !Number.isFinite(input.assignmentConfidence)
    || (input.fitPercentile != null && !Number.isFinite(input.fitPercentile))
  ) {
    return null;
  }

  const domainPriorityIndex = clampUnit(
    input.effectiveDomainWeight / input.maxDomainWeight,
  );
  const fitPercentile = clampUnit(input.fitPercentile ?? 0.5);
  const geometryConfidence = clampUnit(input.geometryConfidence);
  const assignmentConfidence = clampUnit(input.assignmentConfidence);
  const effectiveFit =
    geometryConfidence * fitPercentile
    + (1 - geometryConfidence) * 0.5;

  return clampUnit(
    domainPriorityIndex
    * (0.5 + 0.5 * effectiveFit)
    * assignmentConfidence,
  );
}

export const EXAM_TARGET_UNSEEN_RECALL_PRIOR = 0.2;
export const EXAM_TARGET_BREADTH_FLOOR = 0.35;

export interface DomainGapInput {
  domainCode: string;
  effectiveWeight: number;
  projectedRecall: number | null;
  stateConfidence: number;
}

export interface DomainGapScore {
  domainCode: string;
  effectiveWeight: number;
  effectiveRecall: number;
  userDomainGap: number;
  desiredShare: number;
}

/**
 * Compute the full-target domain distribution. Feasibility is intentionally
 * absent here: a domain with no eligible content keeps its target mass so the
 * allocator can report it as coverage debt rather than renormalizing it away.
 */
export function computeDesiredDomainShares(
  domains: readonly DomainGapInput[],
): Map<string, DomainGapScore> {
  const unnormalized: Array<Omit<DomainGapScore, 'desiredShare'> & { need: number }> = [];
  const seen = new Set<string>();

  for (const domain of domains) {
    if (!domain.domainCode || seen.has(domain.domainCode)) {
      throw new Error(`domainCode must be non-empty and unique: ${domain.domainCode}`);
    }
    seen.add(domain.domainCode);
    if (!Number.isFinite(domain.effectiveWeight) || domain.effectiveWeight < 0) {
      throw new Error(`invalid effectiveWeight for ${domain.domainCode}`);
    }

    const confidence = Number.isFinite(domain.stateConfidence)
      ? clampUnit(domain.stateConfidence)
      : 0;
    const projectedRecall = domain.projectedRecall != null
      && Number.isFinite(domain.projectedRecall)
      ? clampUnit(domain.projectedRecall)
      : EXAM_TARGET_UNSEEN_RECALL_PRIOR;
    const effectiveRecall =
      confidence * projectedRecall
      + (1 - confidence) * EXAM_TARGET_UNSEEN_RECALL_PRIOR;
    const userDomainGap =
      EXAM_TARGET_BREADTH_FLOOR
      + (1 - EXAM_TARGET_BREADTH_FLOOR) * (1 - effectiveRecall);

    unnormalized.push({
      domainCode: domain.domainCode,
      effectiveWeight: domain.effectiveWeight,
      effectiveRecall,
      userDomainGap,
      need: domain.effectiveWeight * userDomainGap,
    });
  }

  const totalNeed = unnormalized.reduce((sum, domain) => sum + domain.need, 0);
  if (!(totalNeed > 0)) {
    throw new Error('exam target domains must contain positive target mass');
  }

  return new Map(unnormalized.map((domain) => [
    domain.domainCode,
    {
      domainCode: domain.domainCode,
      effectiveWeight: domain.effectiveWeight,
      effectiveRecall: domain.effectiveRecall,
      userDomainGap: domain.userDomainGap,
      desiredShare: domain.need / totalNeed,
    },
  ]));
}
