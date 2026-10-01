import type {
  RuntimeConceptExamTargetScore,
  RuntimeItemExamTargetScore,
} from './repository.server';
import { computeDesiredDomainShares, type DomainGapScore } from './scoring';
import type { ExamTargetDefinition } from './types';

const UNSEEN_RECALL_PRIOR = 0.2;

export interface ExamTargetLearnerConceptState {
  projectedRecall: number | null;
  stateConfidence: number;
}

export interface BuildExamTargetLearnerPolicyInput {
  definition: ExamTargetDefinition;
  conceptMappings: ReadonlyMap<string, RuntimeConceptExamTargetScore>;
  conceptStates: ReadonlyMap<string, ExamTargetLearnerConceptState>;
  itemScores: ReadonlyMap<string, RuntimeItemExamTargetScore>;
}

export interface ExamTargetLearnerPolicy {
  desiredDomains: Map<string, DomainGapScore>;
  conceptMultipliers: Map<string, number>;
  itemPersonalizedScores: Map<string, number>;
  unmappedDomainCodes: string[];
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function validUnitOr(value: number | null, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

/**
 * Projects learner concept state through immutable concept-domain mixtures.
 * Missing state is deliberately represented with zero confidence and the
 * conservative unseen prior. Missing mappings remain neutral and are reported
 * as coverage debt rather than being assigned to a guessed domain.
 */
export function buildExamTargetLearnerPolicy(
  input: BuildExamTargetLearnerPolicyInput,
): ExamTargetLearnerPolicy {
  const domainCodes = new Set(input.definition.domains.map(domain => domain.code));
  const accumulated = new Map<string, {
    mappingMass: number;
    recallMass: number;
    confidenceMass: number;
  }>();
  for (const domainCode of domainCodes) {
    accumulated.set(domainCode, { mappingMass: 0, recallMass: 0, confidenceMass: 0 });
  }

  for (const [conceptId, mapping] of input.conceptMappings) {
    const state = input.conceptStates.get(conceptId);
    const recall = validUnitOr(state?.projectedRecall ?? null, UNSEEN_RECALL_PRIOR);
    const stateConfidence = validUnitOr(state?.stateConfidence ?? null, 0);
    const mappingConfidence = validUnitOr(mapping.mappingConfidence, 0);
    for (const [domainCode, rawMix] of Object.entries(mapping.domainMix)) {
      const aggregate = accumulated.get(domainCode);
      if (!aggregate || !Number.isFinite(rawMix) || rawMix <= 0) continue;
      const mass = rawMix * mappingConfidence;
      aggregate.mappingMass += mass;
      aggregate.recallMass += mass * recall;
      aggregate.confidenceMass += mass * stateConfidence;
    }
  }

  const desiredDomains = computeDesiredDomainShares(input.definition.domains.map((domain) => {
    const aggregate = accumulated.get(domain.code)!;
    return {
      domainCode: domain.code,
      effectiveWeight: domain.effectiveWeight,
      projectedRecall: aggregate.mappingMass > 0
        ? aggregate.recallMass / aggregate.mappingMass
        : null,
      stateConfidence: aggregate.mappingMass > 0
        ? aggregate.confidenceMass / aggregate.mappingMass
        : 0,
    };
  }));
  const maxDesiredShare = Math.max(
    ...[...desiredDomains.values()].map(domain => domain.desiredShare),
  );
  const desiredIndex = new Map(
    [...desiredDomains].map(([domainCode, domain]) => [
      domainCode,
      maxDesiredShare > 0 ? clampUnit(domain.desiredShare / maxDesiredShare) : 0,
    ]),
  );

  const conceptMultipliers = new Map<string, number>();
  const influence = input.definition.influence;
  for (const [conceptId, mapping] of input.conceptMappings) {
    let targetNeed = 0;
    for (const [domainCode, mix] of Object.entries(mapping.domainMix)) {
      targetNeed += mix * (desiredIndex.get(domainCode) ?? 0);
    }
    const boundedTargetMultiplier = influence.conceptMultiplierMin
      + (influence.conceptMultiplierMax - influence.conceptMultiplierMin) * clampUnit(targetNeed);
    const confidence = clampUnit(mapping.mappingConfidence);
    conceptMultipliers.set(
      conceptId,
      1 + (boundedTargetMultiplier - 1) * confidence,
    );
  }

  const itemPersonalizedScores = new Map<string, number>();
  for (const [itemKey, itemScore] of input.itemScores) {
    const domainNeed = desiredIndex.get(itemScore.domainCode);
    if (domainNeed === undefined) continue;
    const contentFit = itemScore.domainPriorityIndex > 0
      ? clampUnit(itemScore.itemTargetIndex / itemScore.domainPriorityIndex)
      : clampUnit(itemScore.itemTargetIndex);
    itemPersonalizedScores.set(itemKey, clampUnit(domainNeed * contentFit));
  }

  return {
    desiredDomains,
    conceptMultipliers,
    itemPersonalizedScores,
    unmappedDomainCodes: [...accumulated]
      .filter(([, aggregate]) => !(aggregate.mappingMass > 0))
      .map(([domainCode]) => domainCode)
      .sort(),
  };
}
