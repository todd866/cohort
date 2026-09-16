/**
 * Gate entitled other-source content behind today's exam commitment.
 * Before the latch, the default feed stays native to the current objective.
 * Afterward the caller applies the dessert mix.
 *
 * `dailyTarget` is the effective commitment (adaptive coverage/pace, optionally
 * floored by studyGoal) — not a hardcoded constant.
 */

export type ObjectiveCorePhase =
  | 'core'
  | 'dessert'
  | 'post-exam'
  | 'unavailable';

export interface ObjectiveCoreGate {
  phase: ObjectiveCorePhase;
  minimum: number;
  nativeAnswersToday: number | null;
  unlocked: boolean;
}

function validDate(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function positiveCommitment(value: number | null): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : 0;
}

export function evaluateObjectiveCoreGate(input: {
  now: Date;
  startDate: Date | null;
  examDate: Date | null;
  /** Effective daily commitment (adaptive ± optional studyGoal floor). */
  dailyTarget: number | null;
  nativeAnswersToday: number | null;
}): ObjectiveCoreGate {
  const minimum = positiveCommitment(input.dailyTarget);
  const countIsUsable = Number.isSafeInteger(input.nativeAnswersToday)
    && input.nativeAnswersToday! >= 0;

  if (minimum <= 0) {
    return {
      phase: 'unavailable',
      minimum: 0,
      nativeAnswersToday: countIsUsable ? input.nativeAnswersToday : null,
      unlocked: false,
    };
  }

  if (
    !validDate(input.now)
    || !validDate(input.startDate)
    || !validDate(input.examDate)
    || input.examDate.getTime() <= input.startDate.getTime()
    || !countIsUsable
  ) {
    return {
      phase: 'unavailable',
      minimum,
      nativeAnswersToday: countIsUsable ? input.nativeAnswersToday : null,
      unlocked: false,
    };
  }

  if (input.now.getTime() > input.examDate.getTime()) {
    return {
      phase: 'post-exam',
      minimum,
      nativeAnswersToday: input.nativeAnswersToday,
      unlocked: false,
    };
  }

  const unlocked = input.nativeAnswersToday! >= minimum;
  return {
    phase: unlocked ? 'dessert' : 'core',
    minimum,
    nativeAnswersToday: input.nativeAnswersToday,
    unlocked,
  };
}
