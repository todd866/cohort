import { YEAR3_EXAM_TARGET_ROTATIONS } from './types';

export type ExamTargetEffectiveMode = 'off' | 'shadow' | 'active';

export type ExamTargetAssignment = 'control' | 'treatment';

export type ExamTargetServingLane =
  | 'manifold'
  | 'cache'
  | 'instant'
  | 'starter'
  | 'rereview'
  | 'relearn'
  | 'due'
  | 'focus'
  | 'guest';

export type ExamTargetApplication =
  | 'off'
  | 'shadow'
  | 'active'
  | 'inherited'
  | 'tie-break'
  | 'blueprint-only';

export type ExamTargetFallbackLane = 'manifold' | null;

export type ExamTargetLaneBypassReason =
  | 'mode-off'
  | 'shadow-serves-control'
  | 'control-assignment'
  | 'missing-target-version'
  | 'lane-parity-unavailable'
  | 'cache-version-mismatch'
  | 'paired-computation-required'
  | 'protected-lane-tie-break-only'
  | 'guest-personalization-disabled';

export interface ExamTargetLanePolicyInput {
  effectiveMode: ExamTargetEffectiveMode;
  assignment: ExamTargetAssignment;
  lane: ExamTargetServingLane;
  targetVersion: string | null;
  parity: boolean;
  /** Explicit target scope; non-Year-3 rotations retain the legacy lane policy. */
  targetRotation: string | null;
}

export interface ExamTargetLanePolicyDecision {
  targetApplication: ExamTargetApplication;
  mayServe: boolean;
  fallbackLane: ExamTargetFallbackLane;
  bypassReason: ExamTargetLaneBypassReason | null;
  emittedTargetVersion: string | null;
}

const YEAR3_TARGET_ROTATIONS = new Set<string>(YEAR3_EXAM_TARGET_ROTATIONS);

const FULL_MANIFOLD_PAIRED_LANES = new Set<ExamTargetServingLane>([
  'cache',
  'instant',
  'starter',
  'rereview',
]);

function controlDecision(
  bypassReason: ExamTargetLaneBypassReason,
  mayServe = true,
  fallbackLane: ExamTargetFallbackLane = null,
): ExamTargetLanePolicyDecision {
  return {
    targetApplication: 'off',
    mayServe,
    fallbackLane,
    bypassReason,
    emittedTargetVersion: null,
  };
}

function targetDecision(
  targetApplication: Exclude<ExamTargetApplication, 'off'>,
  targetVersion: string,
  bypassReason: ExamTargetLaneBypassReason | null = null,
): ExamTargetLanePolicyDecision {
  return {
    targetApplication,
    mayServe: true,
    fallbackLane: null,
    bypassReason,
    emittedTargetVersion: targetVersion,
  };
}

/**
 * Resolves whether a serving lane may apply an exam target.
 *
 * Year-3 shadow and active requests reserve paired control/target selection
 * for the full manifold lane, so orchestration shortcuts fall through before
 * their individual parity is considered.
 *
 * `parity` means the lane can reproduce the current target policy. For cache,
 * that specifically means the cached item was produced for `targetVersion`.
 */
export function resolveExamTargetLanePolicy(
  input: ExamTargetLanePolicyInput,
): ExamTargetLanePolicyDecision {
  const {
    assignment,
    effectiveMode,
    lane,
    parity,
    targetRotation,
    targetVersion,
  } = input;

  if (effectiveMode === 'off') {
    return controlDecision('mode-off');
  }

  if (
    (effectiveMode === 'shadow' || effectiveMode === 'active')
    && targetRotation !== null
    && YEAR3_TARGET_ROTATIONS.has(targetRotation)
    && FULL_MANIFOLD_PAIRED_LANES.has(lane)
  ) {
    return controlDecision(
      'paired-computation-required',
      false,
      'manifold',
    );
  }

  if (effectiveMode === 'shadow') {
    if (targetVersion === null) return controlDecision('missing-target-version');
    return parity
      ? targetDecision('shadow', targetVersion, 'shadow-serves-control')
      : controlDecision('lane-parity-unavailable');
  }

  if (assignment === 'control') {
    return controlDecision('control-assignment');
  }

  if (targetVersion === null) {
    const mustFallBack =
      lane === 'instant' || lane === 'starter' || lane === 'cache';

    return controlDecision(
      'missing-target-version',
      !mustFallBack,
      mustFallBack ? 'manifold' : null,
    );
  }

  // An activation pointer is authority to attempt treatment, not proof that a
  // lane implements the selected policy. Target-unaware lanes fail closed to
  // their exact control behavior until their parity gate has passed.
  if (
    !parity
    && lane !== 'instant'
    && lane !== 'starter'
    && lane !== 'cache'
  ) {
    return controlDecision('lane-parity-unavailable');
  }

  switch (lane) {
    case 'manifold':
    case 'focus':
      return targetDecision('active', targetVersion);

    case 'instant':
    case 'starter':
      return parity
        ? targetDecision('active', targetVersion)
        : controlDecision('lane-parity-unavailable', false, 'manifold');

    case 'cache':
      return parity
        ? targetDecision('inherited', targetVersion)
        : controlDecision('cache-version-mismatch', false, 'manifold');

    case 'rereview':
    case 'relearn':
    case 'due':
      return targetDecision(
        'tie-break',
        targetVersion,
        'protected-lane-tie-break-only',
      );

    case 'guest':
      return targetDecision(
        'blueprint-only',
        targetVersion,
        'guest-personalization-disabled',
      );
  }
}
