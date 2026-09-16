import { parseExamTargetDefinition } from './contract';
import { materializeExamTarget } from './policy';
import { EXAM_TARGET_REGISTRY_SOURCE } from './registry-data';
import {
  YEAR3_EXAM_TARGET_ROTATIONS,
  type ExamTargetDefinition,
  type ExamTargetRegistrySource,
  type ExamTargetRotation,
} from './types';

export { YEAR3_EXAM_TARGET_ROTATIONS } from './types';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function parseExamTargetRegistry(
  source: Record<string, ExamTargetRegistrySource>,
): Readonly<Record<ExamTargetRotation, ExamTargetDefinition>> {
  const expected = [...YEAR3_EXAM_TARGET_ROTATIONS].sort();
  const actual = Object.keys(source).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(
      `exam target registry keys must be exactly ${expected.join(', ')}; received ${actual.join(', ')}`,
    );
  }

  const entries = YEAR3_EXAM_TARGET_ROTATIONS.map((rotation) => {
    const sourceTarget = source[rotation];
    if (!sourceTarget || sourceTarget.rotation !== rotation) {
      throw new Error(`exam target registry key ${rotation} does not match its target rotation`);
    }
    return [rotation, parseExamTargetDefinition(materializeExamTarget(sourceTarget))] as const;
  });

  return deepFreeze(Object.fromEntries(entries)) as Readonly<
    Record<ExamTargetRotation, ExamTargetDefinition>
  >;
}

export const EXAM_TARGET_REGISTRY = parseExamTargetRegistry(
  EXAM_TARGET_REGISTRY_SOURCE,
);

export function getExamTargetDefinition(
  rotation: string,
): ExamTargetDefinition | null {
  return YEAR3_EXAM_TARGET_ROTATIONS.includes(rotation as ExamTargetRotation)
    ? EXAM_TARGET_REGISTRY[rotation as ExamTargetRotation]
    : null;
}
