import type { ExamTargetRotation } from './types';

export type ExamTargetActivationMode = 'off' | 'shadow' | 'active';
export type ExamTargetAssignment = 'control' | 'treatment';
export type ExamTargetSnapshotLifecycle =
  | 'built'
  | 'validated'
  | 'active'
  | 'retired';

export type ExamTargetActivationBypassReason =
  | 'hard-off'
  | 'activation-missing'
  | 'activation-off'
  | 'snapshot-missing'
  | 'snapshot-rotation-mismatch'
  | 'snapshot-version-mismatch'
  | 'snapshot-unvalidated'
  | 'snapshot-retired'
  | 'snapshot-privacy-invalid'
  | 'invalid-rollout-basis-points'
  | 'invalid-assignment-bucket'
  | 'outside-rollout'
  | null;

export interface ExamTargetActivationConfig {
  mode: ExamTargetActivationMode;
  /** Integer rollout threshold in the inclusive range 0..10000. */
  rolloutBasisPoints: number;
  /** Opaque identity derived from the registry's existing targetId/revision. */
  targetVersion: string;
}

export interface ExamTargetActivationSnapshot {
  rotation: ExamTargetRotation;
  /** Must match the activation version exactly; it is not reparsed here. */
  targetVersion: string;
  lifecycle: ExamTargetSnapshotLifecycle;
  privacyValidated: boolean;
}

export interface ResolveExamTargetActivationInput {
  hardOff: boolean;
  requestedRotation: ExamTargetRotation;
  activation?: ExamTargetActivationConfig | null;
  snapshot?: ExamTargetActivationSnapshot | null;
  /** Stable assignment bucket in the inclusive range 0..9999. */
  assignmentBucket: number;
}

export interface ResolvedExamTargetActivation {
  effectiveMode: ExamTargetActivationMode;
  assignment: ExamTargetAssignment;
  targetVersion: string | null;
  bypassReason: ExamTargetActivationBypassReason;
}

const off = (
  bypassReason: Exclude<ExamTargetActivationBypassReason, null>
): ResolvedExamTargetActivation => ({
  effectiveMode: 'off',
  assignment: 'control',
  targetVersion: null,
  bypassReason,
});

export function resolveExamTargetActivation(
  input: ResolveExamTargetActivationInput
): ResolvedExamTargetActivation {
  if (input.hardOff) {
    return off('hard-off');
  }

  if (!input.activation) {
    return off('activation-missing');
  }

  if (input.activation.mode === 'off') {
    return off('activation-off');
  }

  if (!input.snapshot) {
    return off('snapshot-missing');
  }

  if (input.snapshot.rotation !== input.requestedRotation) {
    return off('snapshot-rotation-mismatch');
  }

  if (input.snapshot.targetVersion !== input.activation.targetVersion) {
    return off('snapshot-version-mismatch');
  }

  if (input.snapshot.lifecycle === 'built') {
    return off('snapshot-unvalidated');
  }

  if (input.snapshot.lifecycle === 'retired') {
    return off('snapshot-retired');
  }

  if (!input.snapshot.privacyValidated) {
    return off('snapshot-privacy-invalid');
  }

  if (
    !Number.isInteger(input.activation.rolloutBasisPoints) ||
    input.activation.rolloutBasisPoints < 0 ||
    input.activation.rolloutBasisPoints > 10_000
  ) {
    return off('invalid-rollout-basis-points');
  }

  if (
    !Number.isInteger(input.assignmentBucket) ||
    input.assignmentBucket < 0 ||
    input.assignmentBucket > 9_999
  ) {
    return off('invalid-assignment-bucket');
  }

  if (input.activation.mode === 'shadow') {
    return {
      effectiveMode: 'shadow',
      assignment: 'control',
      targetVersion: input.activation.targetVersion,
      bypassReason: null,
    };
  }

  const treatment =
    input.assignmentBucket < input.activation.rolloutBasisPoints;

  return {
    effectiveMode: 'active',
    assignment: treatment ? 'treatment' : 'control',
    targetVersion: input.activation.targetVersion,
    bypassReason: treatment ? null : 'outside-rollout',
  };
}
