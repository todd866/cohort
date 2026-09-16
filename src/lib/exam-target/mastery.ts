export const EXAM_TARGET_MASTERY_POLICY_V1 = {
  version: 'md3.exam-target-mastery/v1',
  minimumSuccessfulRetrievals: 2,
  minimumRetrievalSpanDays: 1,
  minimumExamDayRecall: 0.85,
  minimumConfidence: 0.5,
} as const;

export type ExamTargetMasteryStage =
  | 'scheduled-atomic-core'
  | 'applied-distinction'
  | 'breadth-exploration';

export type AppliedDistinctionKind =
  | 'mechanism'
  | 'discriminator'
  | 'management';

export type ExamTargetMasteryEligibilityReason =
  | 'core-mastery-state-missing'
  | 'core-retrieval-count-insufficient'
  | 'core-retrieval-span-insufficient'
  | 'core-exam-day-recall-insufficient'
  | 'core-confidence-insufficient'
  | 'applied-prerequisites-durable'
  | 'exploration-daily-core-complete';

export interface ExamTargetCoreMasteryEvidence {
  successfulRetrievalCount: number | null;
  /** Days from the first to the last successful retrieval. */
  successfulRetrievalSpanDays: number | null;
  conservativeExamDayRecall: number | null;
  confidence: number | null;
}

interface ExamTargetMasteryUnitBase {
  /** Stable curriculum/fact/application identity; never a source path. */
  unitId: string;
  /** Schedule → lecture → fact ordering supplied by the metadata adapter. */
  curriculumOrder?: number;
}

export interface ScheduledAtomicCoreUnit extends ExamTargetMasteryUnitBase {
  stage: 'scheduled-atomic-core';
  /** Null means no trustworthy state exists and therefore remains core work. */
  evidence: ExamTargetCoreMasteryEvidence | null;
  /** Item-equivalent work; invalid or non-positive values conservatively mean 1. */
  workMass?: number;
}

export interface AppliedDistinctionUnit extends ExamTargetMasteryUnitBase {
  stage: 'applied-distinction';
  appliedKind: AppliedDistinctionKind;
  /** Stable core unit IDs required to attempt this application safely. */
  prerequisiteUnitIds: readonly string[];
}

export interface BreadthExplorationUnit extends ExamTargetMasteryUnitBase {
  stage: 'breadth-exploration';
}

export type ExamTargetMasteryUnit =
  | ScheduledAtomicCoreUnit
  | AppliedDistinctionUnit
  | BreadthExplorationUnit;

export interface ExamTargetMasteryPlanInput {
  units: readonly ExamTargetMasteryUnit[];
  /** Unknown is fail-closed and does not unlock exploration. */
  todayRequiredCoreComplete?: boolean | null;
}

export interface EligibleMasteryUnit {
  unitId: string;
  reasons: ExamTargetMasteryEligibilityReason[];
}

export interface EligibleMasteryStage {
  stage: ExamTargetMasteryStage;
  units: EligibleMasteryUnit[];
}

export interface ExamTargetMasteryPlan {
  policyVersion: typeof EXAM_TARGET_MASTERY_POLICY_V1.version;
  /** Sum of non-durable scheduled atomic core work mass. */
  remainingTargetWork: number;
  durableCoreUnitIds: string[];
  /** Stage order only; downstream access checks still own content eligibility. */
  orderedEligibleStages: EligibleMasteryStage[];
}

interface IndexedUnit {
  unit: ExamTargetMasteryUnit;
  inputIndex: number;
}

interface CoreAssessment {
  indexed: IndexedUnit & { unit: ScheduledAtomicCoreUnit };
  durable: boolean;
  reasons: ExamTargetMasteryEligibilityReason[];
}

function isFiniteInUnitInterval(value: number | null): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 1;
}

function hasMinimumNonNegative(
  value: number | null,
  minimum: number,
): boolean {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum;
}

function assessCoreUnit(indexed: CoreAssessment['indexed']): CoreAssessment {
  const evidence = indexed.unit.evidence;
  if (evidence === null) {
    return {
      indexed,
      durable: false,
      reasons: ['core-mastery-state-missing'],
    };
  }

  const reasons: ExamTargetMasteryEligibilityReason[] = [];
  if (!hasMinimumNonNegative(
    evidence.successfulRetrievalCount,
    EXAM_TARGET_MASTERY_POLICY_V1.minimumSuccessfulRetrievals,
  )) {
    reasons.push('core-retrieval-count-insufficient');
  }
  if (!hasMinimumNonNegative(
    evidence.successfulRetrievalSpanDays,
    EXAM_TARGET_MASTERY_POLICY_V1.minimumRetrievalSpanDays,
  )) {
    reasons.push('core-retrieval-span-insufficient');
  }
  if (
    !isFiniteInUnitInterval(evidence.conservativeExamDayRecall)
    || evidence.conservativeExamDayRecall
      < EXAM_TARGET_MASTERY_POLICY_V1.minimumExamDayRecall
  ) {
    reasons.push('core-exam-day-recall-insufficient');
  }
  if (
    !isFiniteInUnitInterval(evidence.confidence)
    || evidence.confidence < EXAM_TARGET_MASTERY_POLICY_V1.minimumConfidence
  ) {
    reasons.push('core-confidence-insufficient');
  }

  return { indexed, durable: reasons.length === 0, reasons };
}

function curriculumOrder(indexed: IndexedUnit): number {
  const order = indexed.unit.curriculumOrder;
  return typeof order === 'number' && Number.isFinite(order)
    ? order
    : indexed.inputIndex;
}

function byCurriculumOrder(left: IndexedUnit, right: IndexedUnit): number {
  return curriculumOrder(left) - curriculumOrder(right)
    || left.inputIndex - right.inputIndex
    || left.unit.unitId.localeCompare(right.unit.unitId);
}

function conservativeWorkMass(unit: ScheduledAtomicCoreUnit): number {
  return typeof unit.workMass === 'number'
    && Number.isFinite(unit.workMass)
    && unit.workMass > 0
    ? unit.workMass
    : 1;
}

function validateAndIndexUnits(
  units: readonly ExamTargetMasteryUnit[],
): IndexedUnit[] {
  const seen = new Set<string>();
  return units.map((unit, inputIndex) => {
    if (!unit.unitId.trim() || seen.has(unit.unitId)) {
      throw new Error(`unitId must be non-empty and unique: ${unit.unitId}`);
    }
    seen.add(unit.unitId);
    return { unit, inputIndex };
  });
}

/**
 * Produces mastery-stage eligibility only. It does not inspect sources, grant
 * access, rank content, or select a study item.
 */
export function computeExamTargetMasteryPlan(
  input: ExamTargetMasteryPlanInput,
): ExamTargetMasteryPlan {
  const indexedUnits = validateAndIndexUnits(input.units);
  const coreAssessments = indexedUnits
    .filter((indexed): indexed is CoreAssessment['indexed'] => (
      indexed.unit.stage === 'scheduled-atomic-core'
    ))
    .map(assessCoreUnit);
  const durableCoreUnitIds = coreAssessments
    .filter((assessment) => assessment.durable)
    .map((assessment) => assessment.indexed)
    .sort(byCurriculumOrder)
    .map((indexed) => indexed.unit.unitId);
  const durableCore = new Set(durableCoreUnitIds);
  const nonDurableCore = coreAssessments
    .filter((assessment) => !assessment.durable)
    .sort((left, right) => byCurriculumOrder(left.indexed, right.indexed));
  const remainingTargetWork = nonDurableCore.reduce(
    (sum, assessment) => Math.min(
      Number.MAX_SAFE_INTEGER,
      sum + conservativeWorkMass(assessment.indexed.unit),
    ),
    0,
  );

  const orderedEligibleStages: EligibleMasteryStage[] = [];
  if (nonDurableCore.length > 0) {
    orderedEligibleStages.push({
      stage: 'scheduled-atomic-core',
      units: nonDurableCore.map((assessment) => ({
        unitId: assessment.indexed.unit.unitId,
        reasons: assessment.reasons,
      })),
    });
  }

  const eligibleApplied = indexedUnits
    .filter((indexed): indexed is IndexedUnit & { unit: AppliedDistinctionUnit } => (
      indexed.unit.stage === 'applied-distinction'
    ))
    .filter(({ unit }) => {
      const prerequisites = [...new Set(unit.prerequisiteUnitIds)];
      return prerequisites.length > 0
        && prerequisites.every((unitId) => durableCore.has(unitId));
    })
    .sort(byCurriculumOrder);
  if (eligibleApplied.length > 0) {
    orderedEligibleStages.push({
      stage: 'applied-distinction',
      units: eligibleApplied.map(({ unit }) => ({
        unitId: unit.unitId,
        reasons: ['applied-prerequisites-durable'],
      })),
    });
  }

  if (input.todayRequiredCoreComplete === true) {
    const eligibleExploration = indexedUnits
      .filter((indexed) => indexed.unit.stage === 'breadth-exploration')
      .sort(byCurriculumOrder);
    if (eligibleExploration.length > 0) {
      orderedEligibleStages.push({
        stage: 'breadth-exploration',
        units: eligibleExploration.map(({ unit }) => ({
          unitId: unit.unitId,
          reasons: ['exploration-daily-core-complete'],
        })),
      });
    }
  }

  return {
    policyVersion: EXAM_TARGET_MASTERY_POLICY_V1.version,
    remainingTargetWork,
    durableCoreUnitIds,
    orderedEligibleStages,
  };
}
