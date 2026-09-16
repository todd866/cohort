import { USYD_MD3_2026 } from './usyd-md3-2026';
import type { ReviewedMd3Rotation } from './usyd-md3-2026-topic-aliases';

export const CANVAS_CURRICULUM_TARGET_SCHEMA = 'md3.canvas-curriculum-target/v1' as const;

export type CanvasCurriculumRotation =
  | ReviewedMd3Rotation
  | 'year3-common'
  | 'non-target';

export type CanvasSourceUnitKind =
  | 'echo-lesson'
  | 'canvas-page'
  | 'assessment-shell'
  | 'canvas-resource';

export type CanvasSourceIdentity =
  | 'echo-lesson-id'
  | 'echo-verified-asset-placement'
  | 'echo-inventory-placement'
  | 'canvas-module-item';

export type CanvasSourceInclusion = 'target' | 'coverage-debt' | 'excluded';

export type CanvasSourceExclusionReason =
  | 'administrative'
  | 'non-assessable'
  | 'non-target-scope'
  | 'superseded-by-teaching-unit'
  | 'no-reviewed-topic'
  | null;

export type CanvasSourceModality =
  | 'video'
  | 'transcript'
  | 'presentation'
  | 'page'
  | 'quiz'
  | 'assignment'
  | 'file'
  | 'external-link';

export interface CanvasCurriculumSourceUnit {
  id: string;
  rotation: CanvasCurriculumRotation;
  kind: CanvasSourceUnitKind;
  identity: CanvasSourceIdentity;
  canonicalTopicIds: string[];
  teachingWeek: number | null;
  inclusion: CanvasSourceInclusion;
  exclusionReason: CanvasSourceExclusionReason;
  modalities: CanvasSourceModality[];
  assetHashes: string[];
  sourceFingerprint: string;
}

export interface CanvasCurriculumTopicEvidence {
  rotation: ReviewedMd3Rotation;
  canonicalTopicId: string;
  teachingWeek: number | null;
  sourceUnitIds: string[];
}

export interface CanvasCurriculumTargetArtifact {
  schema: typeof CANVAS_CURRICULUM_TARGET_SCHEMA;
  snapshotDate: string;
  observedAt: string;
  curriculumVersion: string;
  sourceIndexHashes: {
    echoSections: string;
    transcriptCoverage: string;
    presentationCoverage: string;
    quizInventory: string;
    canvasModules: string;
  };
  sourceUnits: CanvasCurriculumSourceUnit[];
  topics: CanvasCurriculumTopicEvidence[];
  coverage: {
    targetLessonCount: number;
    mappedLessonCount: number;
    coverageDebtLessonCount: number;
    excludedLessonCount: number;
    lessonMappingRate: number;
  };
}

const ROTATIONS = new Set<CanvasCurriculumRotation>([
  'critical-care',
  'paam',
  'cah',
  'pwh',
  'year3-common',
  'non-target',
]);
const REVIEWED_ROTATIONS = new Set<ReviewedMd3Rotation>([
  'critical-care',
  'paam',
  'cah',
  'pwh',
]);
const UNIT_KINDS = new Set<CanvasSourceUnitKind>([
  'echo-lesson',
  'canvas-page',
  'assessment-shell',
  'canvas-resource',
]);
const IDENTITIES = new Set<CanvasSourceIdentity>([
  'echo-lesson-id',
  'echo-verified-asset-placement',
  'echo-inventory-placement',
  'canvas-module-item',
]);
const INCLUSIONS = new Set<CanvasSourceInclusion>([
  'target',
  'coverage-debt',
  'excluded',
]);
const EXCLUSION_REASONS = new Set<CanvasSourceExclusionReason>([
  'administrative',
  'non-assessable',
  'non-target-scope',
  'superseded-by-teaching-unit',
  'no-reviewed-topic',
  null,
]);
const MODALITIES = new Set<CanvasSourceModality>([
  'video',
  'transcript',
  'presentation',
  'page',
  'quiz',
  'assignment',
  'file',
  'external-link',
]);
const FORBIDDEN_KEY = /(path|url|token|cookie|verifier|signature|title|text|content|answer)/i;
const UNSAFE_STRING = /(?:^(?:https?|file):\/\/|^\/(?:Users|home|private|var|tmp)(?:\/|$)|[?&](?:token|verifier|signature|sig)=)/i;
const SHA256 = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ID_SEGMENT = '[A-Za-z0-9._-]+';

function fail(message: string): never {
  throw new Error(`invalid Canvas curriculum target: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label} has unknown field ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) fail(`${label} is missing field ${key}`);
  }
}

function scanRuntimeBoundary(value: unknown, label = 'artifact'): void {
  if (typeof value === 'string') {
    if (UNSAFE_STRING.test(value)) fail(`${label} contains an unsafe URL or absolute path`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanRuntimeBoundary(entry, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) fail(`${label} contains forbidden field ${key}`);
    scanRuntimeBoundary(entry, `${label}.${key}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative integer`);
  return value as number;
}

function teachingWeek(value: unknown, rotation: CanvasCurriculumRotation, label: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 7) {
    fail(`${label} must be null or a teaching week from 1 to 7`);
  }
  if (rotation === 'pwh') fail('PWH teaching weeks must remain null');
  return value as number;
}

function canonicalTopicSet(rotation: ReviewedMd3Rotation): ReadonlySet<string> {
  const block = USYD_MD3_2026.blocks.find(candidate => candidate.id === rotation);
  if (!block) fail(`missing canonical block ${rotation}`);
  return new Set(block.topics);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const result = value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`);
  return result;
}

function parseSourceUnit(
  value: unknown,
  index: number,
  snapshotDate: string,
): CanvasCurriculumSourceUnit {
  const label = `sourceUnits[${index}]`;
  const input = record(value, label);
  exactKeys(input, [
    'id',
    'rotation',
    'kind',
    'identity',
    'canonicalTopicIds',
    'teachingWeek',
    'inclusion',
    'exclusionReason',
    'modalities',
    'assetHashes',
    'sourceFingerprint',
  ], label);

  const rotation = requiredString(input.rotation, `${label}.rotation`) as CanvasCurriculumRotation;
  if (!ROTATIONS.has(rotation)) fail(`${label}.rotation is unknown`);
  const kind = requiredString(input.kind, `${label}.kind`) as CanvasSourceUnitKind;
  if (!UNIT_KINDS.has(kind)) fail(`${label}.kind is unknown`);
  const identity = requiredString(input.identity, `${label}.identity`) as CanvasSourceIdentity;
  if (!IDENTITIES.has(identity)) fail(`${label}.identity is unknown`);
  const inclusion = requiredString(input.inclusion, `${label}.inclusion`) as CanvasSourceInclusion;
  if (!INCLUSIONS.has(inclusion)) fail(`${label}.inclusion is unknown`);
  const exclusionReason = input.exclusionReason as CanvasSourceExclusionReason;
  if (!EXCLUSION_REASONS.has(exclusionReason)) fail(`${label}.exclusionReason is unknown`);

  const canonicalTopicIds = stringArray(input.canonicalTopicIds, `${label}.canonicalTopicIds`);
  if (REVIEWED_ROTATIONS.has(rotation as ReviewedMd3Rotation)) {
    const canonical = canonicalTopicSet(rotation as ReviewedMd3Rotation);
    for (const topicId of canonicalTopicIds) {
      if (!canonical.has(topicId)) fail(`${label} has unknown canonical topic ${topicId}`);
    }
  } else if (canonicalTopicIds.length > 0) {
    fail(`${label} cannot target canonical topics outside a reviewed rotation`);
  }

  if (inclusion === 'target' && canonicalTopicIds.length === 0) {
    fail(`${label} target units require canonical topics`);
  }
  if (inclusion === 'target' && exclusionReason !== null) {
    fail(`${label} target units cannot have an exclusion reason`);
  }
  if (inclusion !== 'target' && exclusionReason === null) {
    fail(`${label} non-target units require a typed reason`);
  }
  if (!REVIEWED_ROTATIONS.has(rotation as ReviewedMd3Rotation) && inclusion !== 'excluded') {
    fail(`${label} non-reviewed rotations must be excluded`);
  }

  const modalities = stringArray(input.modalities, `${label}.modalities`) as CanvasSourceModality[];
  for (const modality of modalities) {
    if (!MODALITIES.has(modality)) fail(`${label} has unknown modality ${modality}`);
  }
  const assetHashes = stringArray(input.assetHashes, `${label}.assetHashes`);
  for (const hash of assetHashes) {
    if (!SHA256.test(hash)) fail(`${label} has an invalid asset hash`);
  }
  const sourceFingerprint = requiredString(input.sourceFingerprint, `${label}.sourceFingerprint`);
  if (!SHA256.test(sourceFingerprint)) fail(`${label}.sourceFingerprint must be SHA-256`);
  const id = requiredString(input.id, `${label}.id`);
  const escapedDate = snapshotDate.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const patterns: Record<CanvasSourceIdentity, RegExp> = {
    'echo-lesson-id': new RegExp(
      `^canvas:${escapedDate}:echo:${SAFE_ID_SEGMENT}:lesson:${SAFE_ID_SEGMENT}$`,
    ),
    'echo-verified-asset-placement': new RegExp(
      `^canvas:${escapedDate}:echo:${SAFE_ID_SEGMENT}:asset:[a-f0-9]{64}$`,
    ),
    'echo-inventory-placement': new RegExp(
      `^canvas:${escapedDate}:echo:${SAFE_ID_SEGMENT}:placement:\\d+$`,
    ),
    'canvas-module-item': new RegExp(
      `^canvas:${escapedDate}:course:${SAFE_ID_SEGMENT}:module-item:${SAFE_ID_SEGMENT}$`,
    ),
  };
  if (!patterns[identity].test(id)) fail(`${label}.id does not match ${identity}`);
  const echoIdentity = identity !== 'canvas-module-item';
  if (echoIdentity !== (kind === 'echo-lesson')) {
    fail(`${label}.kind does not match ${identity}`);
  }
  if (identity === 'echo-verified-asset-placement' && assetHashes.length === 0) {
    fail(`${label} verified asset identity requires an asset hash`);
  }
  if (identity === 'echo-inventory-placement' && assetHashes.length > 0) {
    fail(`${label} hashed placements require a verified asset identity`);
  }

  return {
    id,
    rotation,
    kind,
    identity,
    canonicalTopicIds,
    teachingWeek: teachingWeek(input.teachingWeek, rotation, `${label}.teachingWeek`),
    inclusion,
    exclusionReason,
    modalities,
    assetHashes,
    sourceFingerprint,
  };
}

export function parseCanvasCurriculumTarget(value: unknown): CanvasCurriculumTargetArtifact {
  scanRuntimeBoundary(value);
  const input = record(value, 'artifact');
  exactKeys(input, [
    'schema',
    'snapshotDate',
    'observedAt',
    'curriculumVersion',
    'sourceIndexHashes',
    'sourceUnits',
    'topics',
    'coverage',
  ], 'artifact');
  if (input.schema !== CANVAS_CURRICULUM_TARGET_SCHEMA) fail('schema is unsupported');
  const snapshotDate = requiredString(input.snapshotDate, 'snapshotDate');
  if (!DATE.test(snapshotDate)) fail('snapshotDate must be YYYY-MM-DD');
  const observedAt = requiredString(input.observedAt, 'observedAt');
  if (!Number.isFinite(Date.parse(observedAt))) fail('observedAt must be an ISO date-time');

  const hashInput = record(input.sourceIndexHashes, 'sourceIndexHashes');
  exactKeys(hashInput, [
    'echoSections',
    'transcriptCoverage',
    'presentationCoverage',
    'quizInventory',
    'canvasModules',
  ], 'sourceIndexHashes');
  const sourceIndexHashes = {
    echoSections: requiredString(hashInput.echoSections, 'sourceIndexHashes.echoSections'),
    transcriptCoverage: requiredString(hashInput.transcriptCoverage, 'sourceIndexHashes.transcriptCoverage'),
    presentationCoverage: requiredString(hashInput.presentationCoverage, 'sourceIndexHashes.presentationCoverage'),
    quizInventory: requiredString(hashInput.quizInventory, 'sourceIndexHashes.quizInventory'),
    canvasModules: requiredString(hashInput.canvasModules, 'sourceIndexHashes.canvasModules'),
  };
  for (const [name, hash] of Object.entries(sourceIndexHashes)) {
    if (!SHA256.test(hash)) fail(`sourceIndexHashes.${name} must be SHA-256`);
  }

  if (!Array.isArray(input.sourceUnits)) fail('sourceUnits must be an array');
  const sourceUnits = input.sourceUnits.map((unit, index) => (
    parseSourceUnit(unit, index, snapshotDate)
  ));
  const unitsById = new Map(sourceUnits.map(unit => [unit.id, unit]));
  if (unitsById.size !== sourceUnits.length) fail('source unit IDs must be unique');

  if (!Array.isArray(input.topics)) fail('topics must be an array');
  const topics = input.topics.map((value, index): CanvasCurriculumTopicEvidence => {
    const label = `topics[${index}]`;
    const topicInput = record(value, label);
    exactKeys(topicInput, [
      'rotation',
      'canonicalTopicId',
      'teachingWeek',
      'sourceUnitIds',
    ], label);
    const rotation = requiredString(topicInput.rotation, `${label}.rotation`) as ReviewedMd3Rotation;
    if (!REVIEWED_ROTATIONS.has(rotation)) fail(`${label}.rotation is not reviewed`);
    const canonicalTopicId = requiredString(topicInput.canonicalTopicId, `${label}.canonicalTopicId`);
    if (!canonicalTopicSet(rotation).has(canonicalTopicId)) {
      fail(`${label} has unknown canonical topic ${canonicalTopicId}`);
    }
    const sourceUnitIds = stringArray(topicInput.sourceUnitIds, `${label}.sourceUnitIds`);
    for (const id of sourceUnitIds) {
      const unit = unitsById.get(id);
      if (!unit) fail(`${label} references missing source unit ${id}`);
      if (unit.inclusion !== 'target' || unit.rotation !== rotation
        || !unit.canonicalTopicIds.includes(canonicalTopicId)) {
        fail(`${label} references an incompatible source unit ${id}`);
      }
    }
    return {
      rotation,
      canonicalTopicId,
      teachingWeek: teachingWeek(topicInput.teachingWeek, rotation, `${label}.teachingWeek`),
      sourceUnitIds,
    };
  });
  const topicKeys = topics.map(topic => `${topic.rotation}:${topic.canonicalTopicId}`);
  if (new Set(topicKeys).size !== topicKeys.length) fail('topic evidence rows must be unique');

  const coverageInput = record(input.coverage, 'coverage');
  exactKeys(coverageInput, [
    'targetLessonCount',
    'mappedLessonCount',
    'coverageDebtLessonCount',
    'excludedLessonCount',
    'lessonMappingRate',
  ], 'coverage');
  const coverage = {
    targetLessonCount: requiredInteger(coverageInput.targetLessonCount, 'coverage.targetLessonCount'),
    mappedLessonCount: requiredInteger(coverageInput.mappedLessonCount, 'coverage.mappedLessonCount'),
    coverageDebtLessonCount: requiredInteger(
      coverageInput.coverageDebtLessonCount,
      'coverage.coverageDebtLessonCount',
    ),
    excludedLessonCount: requiredInteger(coverageInput.excludedLessonCount, 'coverage.excludedLessonCount'),
    lessonMappingRate: coverageInput.lessonMappingRate as number,
  };
  if (typeof coverage.lessonMappingRate !== 'number'
    || !Number.isFinite(coverage.lessonMappingRate)
    || coverage.lessonMappingRate < 0
    || coverage.lessonMappingRate > 1) {
    fail('coverage.lessonMappingRate must be between 0 and 1');
  }
  if (coverage.mappedLessonCount + coverage.coverageDebtLessonCount
    !== coverage.targetLessonCount) {
    fail('coverage lesson counts are inconsistent');
  }
  const targetLessons = sourceUnits.filter(unit => unit.kind === 'echo-lesson'
    && REVIEWED_ROTATIONS.has(unit.rotation as ReviewedMd3Rotation)
    && unit.inclusion !== 'excluded');
  const mappedLessonCount = targetLessons.filter(unit => unit.inclusion === 'target').length;
  const coverageDebtLessonCount = targetLessons.length - mappedLessonCount;
  const excludedLessonCount = sourceUnits.filter(unit => unit.kind === 'echo-lesson'
    && REVIEWED_ROTATIONS.has(unit.rotation as ReviewedMd3Rotation)
    && unit.inclusion === 'excluded').length;
  const mappingRate = targetLessons.length > 0 ? mappedLessonCount / targetLessons.length : 1;
  if (coverage.targetLessonCount !== targetLessons.length
    || coverage.mappedLessonCount !== mappedLessonCount
    || coverage.coverageDebtLessonCount !== coverageDebtLessonCount
    || coverage.excludedLessonCount !== excludedLessonCount
    || Math.abs(coverage.lessonMappingRate - mappingRate) > Number.EPSILON) {
    fail('coverage does not match source units');
  }

  return {
    schema: CANVAS_CURRICULUM_TARGET_SCHEMA,
    snapshotDate,
    observedAt,
    curriculumVersion: requiredString(input.curriculumVersion, 'curriculumVersion'),
    sourceIndexHashes,
    sourceUnits,
    topics,
    coverage,
  };
}

export function canvasSourceUnitIdsForTopics(
  artifact: CanvasCurriculumTargetArtifact,
  rotation: ReviewedMd3Rotation,
  canonicalTopicIds: readonly string[],
): string[] {
  const requested = new Set(canonicalTopicIds);
  return [...new Set(artifact.topics
    .filter(topic => topic.rotation === rotation && requested.has(topic.canonicalTopicId))
    .flatMap(topic => topic.sourceUnitIds))]
    .sort();
}

export interface CurrentCanvasCurriculumSourceUnit {
  sourceUnitId: string;
  teachingWeek: number | null;
}

/**
 * Prefer current teaching material for a topic. When Canvas exposes an
 * explicitly reviewed topic only as a targeted assessment shell, retain that sanitized
 * shell ID as curriculum provenance instead of making the topic impossible to
 * schedule. The shell contributes membership only; no question body crosses
 * this runtime boundary.
 */
export function currentCanvasCurriculumSourceUnitsForTopic(
  artifact: CanvasCurriculumTargetArtifact,
  rotation: ReviewedMd3Rotation,
  canonicalTopicId: string,
): CurrentCanvasCurriculumSourceUnit[] {
  const topic = artifact.topics.find(candidate => (
    candidate.rotation === rotation && candidate.canonicalTopicId === canonicalTopicId
  ));
  if (!topic) return [];
  const requested = new Set(topic.sourceUnitIds);
  const current = artifact.sourceUnits
    .filter(unit => requested.has(unit.id)
      && unit.rotation === rotation
      && unit.inclusion === 'target');
  const teaching = current.filter(unit => unit.kind !== 'assessment-shell');
  const selected = teaching.length > 0
    ? teaching
    : current.filter(unit => unit.kind === 'assessment-shell');
  return selected
    .map(unit => ({ sourceUnitId: unit.id, teachingWeek: unit.teachingWeek }))
    .sort((left, right) => left.sourceUnitId.localeCompare(right.sourceUnitId));
}
