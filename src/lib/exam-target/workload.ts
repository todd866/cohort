export interface ExamTargetWorkloadInput {
  /** Calendar/work horizon used by the existing remaining-budget model. */
  daysToExam: number | null;
  /**
   * Conservative item-equivalent work still required for the current exam.
   * Readiness and confidence belong in this upstream estimate, not in the
   * serving-seat allocator.
   */
  remainingTargetWork: number | null;
  /** Gross items/day, before this request's known protected work. */
  dailyCapacity: number | null;
  /** Total seats requested, including due/relearn protected seats. */
  requestedBatchSize: number;
  /** Known protected seats in this request. They are reserved first. */
  protectedCount: number | null;
  /** Current-exam work already completed before this request. */
  completedTargetWorkToday?: number | null;
  /** Protected seats in this request that also satisfy the current exam. */
  protectedTargetCount?: number | null;
}

export interface ExamTargetWorkload {
  requestedSeats: number;
  protectedSeats: number;
  protectedTargetSeats: number;
  discretionarySeats: number;
  /** Gross whole item-equivalent capacity left before the exam. */
  availableTargetWorkCapacity: number;
  completedTargetWorkToday: number;
  requiredTargetWorkToday: number | null;
  /** Today's requirement after already-completed work, before this batch. */
  remainingTargetWorkToday: number | null;
  /** Discretionary seats reserved for the current exam target. */
  coreTargetSeats: number;
  /** Discretionary seats that may use other already-authorised material. */
  surplusSeats: number;
  onTrack: boolean;
  /** Null means the target-work estimate or exam horizon was unusable. */
  shortfall: number | null;
}

function isFiniteNonNegative(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function toSafeFloor(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function toSafeCeil(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.ceil(value)));
}

function requestedSeatsFor(value: number): number {
  return Number.isFinite(value) && value > 0 ? toSafeFloor(value) : 0;
}

function protectedSeatsFor(
  value: number | null,
  requestedSeats: number,
): number {
  // An unknown protected count must not be interpreted as permission to take
  // seats from due/relearn work.
  if (!isFiniteNonNegative(value)) return requestedSeats;
  return Math.min(requestedSeats, Math.ceil(value));
}

function creditedSeatsFor(
  value: number | null | undefined,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  // Unknown or fractional credit must not reduce the target quota.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(maximum, toSafeFloor(value));
}

function horizonCapacity(
  daysToExam: number | null,
  dailyCapacity: number | null,
): number {
  if (!isFiniteNonNegative(daysToExam) || !isFiniteNonNegative(dailyCapacity)) {
    return 0;
  }

  const grossCapacity = daysToExam * dailyCapacity;
  if (!Number.isFinite(grossCapacity)) return 0;

  // This matches computeRemainingBudget's gross throughput × days horizon.
  // Protected target work contributes to both the target and the gross budget,
  // so subtracting it here would count the same obligation twice.
  return toSafeFloor(grossCapacity);
}

/**
 * Partitions one serving request after protected work has been reserved.
 *
 * The current-exam core is its minimum daily pace. Work already completed today
 * and target-relevant protected work satisfy that quota before discretionary
 * seats are claimed. Only the remainder is surplus for other authorised
 * material. This function allocates counts only; it grants no source access or
 * selects content.
 */
export function computeExamTargetWorkload(
  input: ExamTargetWorkloadInput,
): ExamTargetWorkload {
  const requestedSeats = requestedSeatsFor(input.requestedBatchSize);
  const protectedSeats = protectedSeatsFor(input.protectedCount, requestedSeats);
  const protectedTargetSeats = creditedSeatsFor(
    input.protectedTargetCount,
    protectedSeats,
  );
  const discretionarySeats = requestedSeats - protectedSeats;
  const completedTargetWorkToday = creditedSeatsFor(
    input.completedTargetWorkToday,
  );
  const availableTargetWorkCapacity = horizonCapacity(
    input.daysToExam,
    input.dailyCapacity,
  );

  if (
    !isFiniteNonNegative(input.remainingTargetWork)
    || !isFiniteNonNegative(input.daysToExam)
  ) {
    return {
      requestedSeats,
      protectedSeats,
      protectedTargetSeats,
      discretionarySeats,
      availableTargetWorkCapacity,
      completedTargetWorkToday,
      requiredTargetWorkToday: null,
      remainingTargetWorkToday: null,
      coreTargetSeats: discretionarySeats,
      surplusSeats: 0,
      onTrack: false,
      shortfall: null,
    };
  }

  const remainingTargetWork = input.remainingTargetWork;
  const requiredTargetWorkToday = isFiniteNonNegative(input.daysToExam)
    && input.daysToExam > 0
    ? toSafeCeil(remainingTargetWork / input.daysToExam)
    : toSafeCeil(remainingTargetWork);
  const remainingTargetWorkToday = Math.max(
    0,
    requiredTargetWorkToday - completedTargetWorkToday,
  );
  const unmetAfterProtected = Math.max(
    0,
    remainingTargetWorkToday - protectedTargetSeats,
  );
  const coreTargetSeats = Math.min(
    discretionarySeats,
    unmetAfterProtected,
  );
  const surplusSeats = discretionarySeats - coreTargetSeats;
  const shortfall = Math.max(
    0,
    remainingTargetWork - availableTargetWorkCapacity,
  );

  return {
    requestedSeats,
    protectedSeats,
    protectedTargetSeats,
    discretionarySeats,
    availableTargetWorkCapacity,
    completedTargetWorkToday,
    requiredTargetWorkToday,
    remainingTargetWorkToday,
    coreTargetSeats,
    surplusSeats,
    onTrack: shortfall === 0,
    shortfall,
  };
}
