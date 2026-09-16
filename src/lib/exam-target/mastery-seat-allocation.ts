import type { ExamTargetMasteryStage } from './mastery';

const MASTERY_STAGES = new Set<ExamTargetMasteryStage>([
  'scheduled-atomic-core',
  'applied-distinction',
  'breadth-exploration',
]);

export interface ExamTargetMasterySeatCandidate {
  /** Already-authorized item identity. */
  itemKey: string;
  /** Stable mastery-unit identity assigned upstream. */
  unitId: string;
  stage: ExamTargetMasteryStage;
}

export type ExamTargetEligibleUnitIdsByStage = Partial<Record<
  ExamTargetMasteryStage,
  readonly string[] | null
>>;

export interface AllocateExamTargetMasterySeatsInput {
  /** Authorization and pedagogical ordering are both owned upstream. */
  candidates: readonly ExamTargetMasterySeatCandidate[];
  /** Eligibility is membership-only and cannot widen the candidate list. */
  eligibleUnitIdsByStage: ExamTargetEligibleUnitIdsByStage;
  coreTargetSeats?: number | null;
  surplusSeats?: number | null;
}

export interface ExamTargetMasterySeatAllocation {
  selectedCandidates: ExamTargetMasterySeatCandidate[];
  effectiveCoreTargetSeats: number;
  effectiveSurplusSeats: number;
  coreSelectedCount: number;
  appliedSelectedCount: number;
  breadthSelectedCount: number;
  surplusSelectedCount: number;
  totalSelectedCount: number;
  coreShortfall: number;
  quotaFailClosed: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStableIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\r\n\0]/.test(value);
}

function normalizeCandidates(value: unknown): ExamTargetMasterySeatCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: ExamTargetMasterySeatCandidate[] = [];
  for (const candidate of value) {
    if (!isPlainRecord(candidate)
      || !isStableIdentity(candidate.itemKey)
      || !isStableIdentity(candidate.unitId)
      || typeof candidate.stage !== 'string'
      || !MASTERY_STAGES.has(candidate.stage as ExamTargetMasteryStage)) {
      continue;
    }
    candidates.push({
      itemKey: candidate.itemKey,
      unitId: candidate.unitId,
      stage: candidate.stage as ExamTargetMasteryStage,
    });
  }
  return candidates;
}

function eligibleUnitSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter(isStableIdentity));
}

function isValidQuota(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function safeSeatSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function effectiveQuotas(input: AllocateExamTargetMasterySeatsInput): {
  core: number;
  surplus: number;
  failClosed: boolean;
} {
  const core = isValidQuota(input.coreTargetSeats) ? input.coreTargetSeats : null;
  const surplus = isValidQuota(input.surplusSeats) ? input.surplusSeats : null;
  if (core !== null && surplus !== null) {
    return {
      core,
      surplus,
      failClosed: false,
    };
  }

  // A known surplus count is capacity, not permission to broaden, when either
  // quota is unusable. Preserve only known capacity and point all of it at core.
  return {
    core: safeSeatSum(
      core ?? 0,
      surplus ?? 0,
    ),
    surplus: 0,
    failClosed: true,
  };
}

/**
 * Allocates only within an authorized, pre-ordered candidate set.
 *
 * Stage precedence is fixed: scheduled atomic core owns its reserved seats;
 * declared surplus then considers applied distinctions before explicitly
 * eligible breadth. Candidate order is stable within each stage. One mastery
 * unit and one item key can each consume at most one seat.
 */
export function allocateExamTargetMasterySeats(
  input: AllocateExamTargetMasterySeatsInput,
): ExamTargetMasterySeatAllocation {
  const candidates = normalizeCandidates(input?.candidates);
  const eligibility = isPlainRecord(input?.eligibleUnitIdsByStage)
    ? input.eligibleUnitIdsByStage
    : {};
  const eligibleCore = eligibleUnitSet(eligibility['scheduled-atomic-core']);
  const eligibleApplied = eligibleUnitSet(eligibility['applied-distinction']);
  const eligibleBreadth = eligibleUnitSet(eligibility['breadth-exploration']);
  const quotas = effectiveQuotas(input);
  const selectedCandidates: ExamTargetMasterySeatCandidate[] = [];
  const selectedItemKeys = new Set<string>();
  const selectedUnitIds = new Set<string>();

  const selectStage = (
    stage: ExamTargetMasteryStage,
    eligibleUnitIds: ReadonlySet<string>,
    limit: number,
  ): number => {
    let selected = 0;
    for (const candidate of candidates) {
      if (selected >= limit) break;
      if (candidate.stage !== stage
        || !eligibleUnitIds.has(candidate.unitId)
        || selectedItemKeys.has(candidate.itemKey)
        || selectedUnitIds.has(candidate.unitId)) {
        continue;
      }
      selectedCandidates.push({ ...candidate });
      selectedItemKeys.add(candidate.itemKey);
      selectedUnitIds.add(candidate.unitId);
      selected += 1;
    }
    return selected;
  };

  const coreSelectedCount = selectStage(
    'scheduled-atomic-core',
    eligibleCore,
    quotas.core,
  );
  const appliedSelectedCount = selectStage(
    'applied-distinction',
    eligibleApplied,
    quotas.surplus,
  );
  const breadthSelectedCount = selectStage(
    'breadth-exploration',
    eligibleBreadth,
    quotas.surplus - appliedSelectedCount,
  );
  const surplusSelectedCount = appliedSelectedCount + breadthSelectedCount;

  return {
    selectedCandidates,
    effectiveCoreTargetSeats: quotas.core,
    effectiveSurplusSeats: quotas.surplus,
    coreSelectedCount,
    appliedSelectedCount,
    breadthSelectedCount,
    surplusSelectedCount,
    totalSelectedCount: coreSelectedCount + surplusSelectedCount,
    coreShortfall: quotas.core - coreSelectedCount,
    quotaFailClosed: quotas.failClosed,
  };
}
