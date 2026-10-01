import { examTargetVersionId } from './contract';
import { EXAM_TARGET_REGISTRY, YEAR3_EXAM_TARGET_ROTATIONS } from './registry';
import type { ExamTargetRotation } from './types';

export type ExamTargetOperatorCommand =
  | 'compile'
  | 'privacy-validate'
  | 'shadow'
  | 'rollback'
  | 'retire'
  | 'audit-validate'
  | 'audit-reachability'
  | 'audit-shadow';

export interface ExamTargetOperatorTarget {
  rotation: ExamTargetRotation;
  targetVersion: string;
}

export interface ParsedExamTargetOperatorArgs {
  command: ExamTargetOperatorCommand;
  mode: 'dry-run' | 'apply';
  targets: readonly ExamTargetOperatorTarget[];
  operator: string | null;
  auditedBy: string | null;
  reason: string | null;
  generatedBy: string | null;
  supersedesId: string | null;
  days: number;
  privacyGates: {
    runtimeArtifactContract: boolean;
    targetTraceAllowlist: boolean;
    embeddingEgress: boolean;
  };
}

const COMMANDS = new Set<ExamTargetOperatorCommand>([
  'compile',
  'privacy-validate',
  'shadow',
  'rollback',
  'retire',
  'audit-validate',
  'audit-reachability',
  'audit-shadow',
]);
const AUDIT_COMMANDS = new Set<ExamTargetOperatorCommand>([
  'audit-validate',
  'audit-reachability',
  'audit-shadow',
]);
const VALUE_OPTIONS = new Set([
  '--rotation',
  '--target-version',
  '--operator',
  '--audited-by',
  '--reason',
  '--generated-by',
  '--supersedes-id',
  '--days',
]);
const BOOLEAN_OPTIONS = new Set([
  '--apply',
  '--all',
  '--gate-runtime-artifact',
  '--gate-target-trace',
  '--gate-embedding-egress',
]);

function exactTarget(rotationValue: string, version: string): ExamTargetOperatorTarget {
  if (!YEAR3_EXAM_TARGET_ROTATIONS.includes(rotationValue as ExamTargetRotation)) {
    throw new Error(`unsupported Year-3 exam-target rotation ${rotationValue}`);
  }
  const rotation = rotationValue as ExamTargetRotation;
  if (examTargetVersionId(EXAM_TARGET_REGISTRY[rotation]) !== version) {
    throw new Error(
      `--target-version must exactly match the reviewed ${rotation} registry entry`,
    );
  }
  return { rotation, targetVersion: version };
}

export function parseExamTargetOperatorArgs(
  argv: readonly string[],
): ParsedExamTargetOperatorArgs {
  const [rawCommand, ...rawOptions] = argv;
  if (!COMMANDS.has(rawCommand as ExamTargetOperatorCommand)) {
    throw new Error(`unsupported exam-target operator command ${rawCommand ?? ''}`.trim());
  }
  const command = rawCommand as ExamTargetOperatorCommand;
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < rawOptions.length; index += 1) {
    const option = rawOptions[index];
    if (VALUE_OPTIONS.has(option)) {
      if (values.has(option)) throw new Error(`duplicate option ${option}`);
      const value = rawOptions[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${option} requires a value`);
      }
      values.set(option, value);
      index += 1;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(option)) {
      if (booleans.has(option)) throw new Error(`duplicate option ${option}`);
      booleans.add(option);
      continue;
    }
    throw new Error(`unknown option ${option}`);
  }

  if (AUDIT_COMMANDS.has(command) && booleans.has('--apply')) {
    throw new Error('audit commands are read-only');
  }
  if (!AUDIT_COMMANDS.has(command) && booleans.has('--all')) {
    throw new Error('mutating-capable commands require one exact target');
  }
  const all = booleans.has('--all');
  const rotation = values.get('--rotation');
  const targetVersion = values.get('--target-version');
  if (all && (rotation || targetVersion)) {
    throw new Error('--all cannot be combined with an exact target');
  }
  if (!all && (!rotation || !targetVersion)) {
    throw new Error('command requires both --rotation and --target-version');
  }
  const targets = all
    ? YEAR3_EXAM_TARGET_ROTATIONS.map(candidate => ({
        rotation: candidate,
        targetVersion: examTargetVersionId(EXAM_TARGET_REGISTRY[candidate]),
      }))
    : [exactTarget(rotation!, targetVersion!)];

  const daysValue = values.get('--days');
  const days = daysValue == null ? 30 : Number(daysValue);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error('--days must be an integer from 1 to 90');
  }
  if (command !== 'audit-shadow' && daysValue != null) {
    throw new Error('--days is supported only by audit-shadow');
  }

  const operator = values.get('--operator') ?? null;
  const auditedBy = values.get('--audited-by') ?? null;
  if (
    (command === 'shadow' || command === 'rollback' || command === 'retire')
    && operator == null
  ) {
    throw new Error(`${command} requires --operator`);
  }
  if (command === 'privacy-validate' && auditedBy == null) {
    throw new Error('privacy-validate requires --audited-by');
  }

  const privacyGates = {
    runtimeArtifactContract: booleans.has('--gate-runtime-artifact'),
    targetTraceAllowlist: booleans.has('--gate-target-trace'),
    embeddingEgress: booleans.has('--gate-embedding-egress'),
  };
  const anyPrivacyGate = Object.values(privacyGates).some(Boolean);
  if (command !== 'privacy-validate' && anyPrivacyGate) {
    throw new Error('privacy gate flags are supported only by privacy-validate');
  }

  return {
    command,
    mode: booleans.has('--apply') ? 'apply' : 'dry-run',
    targets,
    operator,
    auditedBy,
    reason: values.get('--reason') ?? null,
    generatedBy: values.get('--generated-by') ?? null,
    supersedesId: values.get('--supersedes-id') ?? null,
    days,
    privacyGates,
  };
}
