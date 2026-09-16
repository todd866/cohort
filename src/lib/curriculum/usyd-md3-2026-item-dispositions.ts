import rawArtifact from './usyd-md3-2026-item-dispositions.json';

import { USYD_MD3_2026 } from './usyd-md3-2026';
import {
  resolveReviewedMd3TopicAlias,
  type ReviewedMd3Rotation,
} from './usyd-md3-2026-topic-aliases';

export type ReviewedCurriculumInventory = 'card' | 'question';

export type ReviewedNeutralReason =
  | 'access-gated-media'
  | 'external-exam-supplement'
  | 'legacy-exam-practice'
  | 'legacy-import'
  | 'reinforcement-supplement'
  | 'student-anki-supplement'
  | 'supplemental-breadth'
  | 'supplemental-external-source'
  | 'supplemental-native-enrichment'
  | 'textbook-supplement';

export type ReviewedNeutralMatchKind = 'id-exact';

export interface ReviewedNeutralRule {
  inventory: ReviewedCurriculumInventory;
  rotation: ReviewedMd3Rotation;
  matchKind: ReviewedNeutralMatchKind;
  value: string;
  reason: ReviewedNeutralReason;
}

export interface ReviewedItemTopicOverride {
  inventory: ReviewedCurriculumInventory;
  rotation: ReviewedMd3Rotation;
  itemId: string;
  canonicalTopicIds: string[];
}

export interface ReviewedCurriculumDispositionArtifact {
  schema: 'md3.curriculum-item-dispositions/v2';
  revision: number;
  reviewedAt: string;
  reviewedBy: string;
  neutralRules: ReviewedNeutralRule[];
  itemTopicOverrides: ReviewedItemTopicOverride[];
}

export interface ResolveReviewedCurriculumItemInput {
  inventory: ReviewedCurriculumInventory;
  rotation: ReviewedMd3Rotation;
  itemId: string;
  sourceFile: string | null;
  topics: readonly string[];
}

export interface ResolvedReviewedCurriculumItem {
  canonicalTopicIds: string[];
  reviewedNeutralReason: ReviewedNeutralReason | null;
}

export interface CompiledRuntimeCurriculumDispositionPolicy {
  neutral_rules: Array<{
    inventory: ReviewedCurriculumInventory;
    match_kind: ReviewedNeutralMatchKind;
    value: string;
  }>;
  item_topic_overrides: Array<{
    inventory: ReviewedCurriculumInventory;
    item_id: string;
    canonical_topic_ids: string[];
  }>;
}

const ROTATIONS = new Set<ReviewedMd3Rotation>([
  'cah', 'critical-care', 'paam', 'pwh',
]);
const INVENTORIES = new Set<ReviewedCurriculumInventory>(['card', 'question']);
const MATCH_KINDS = new Set<ReviewedNeutralMatchKind>([
  'id-exact',
]);
const NEUTRAL_REASONS = new Set<ReviewedNeutralReason>([
  'access-gated-media',
  'external-exam-supplement',
  'legacy-exam-practice',
  'legacy-import',
  'reinforcement-supplement',
  'student-anki-supplement',
  'supplemental-breadth',
  'supplemental-external-source',
  'supplemental-native-enrichment',
  'textbook-supplement',
]);

function fail(message: string): never {
  throw new Error(`invalid curriculum item dispositions: ${message}`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty, trimmed string`);
  }
  return value;
}

function canonicalTopicSet(rotation: ReviewedMd3Rotation): ReadonlySet<string> {
  const block = USYD_MD3_2026.blocks.find(candidate => candidate.id === rotation);
  if (!block) fail(`missing canonical block ${rotation}`);
  return new Set(block.topics);
}

function canonicalTopicIds(
  value: unknown,
  rotation: ReviewedMd3Rotation,
  label: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array`);
  }
  const canonical = canonicalTopicSet(rotation);
  const result = value.map((entry, index) => {
    const topic = requiredString(entry, `${label}[${index}]`);
    if (!canonical.has(topic)) fail(`${label} contains unknown canonical topic ${topic}`);
    return topic;
  });
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`);
  return result.sort();
}

function parseArtifact(value: unknown): ReviewedCurriculumDispositionArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('artifact must be an object');
  const input = value as Record<string, unknown>;
  const exactKeys = [
    'schema', 'revision', 'reviewedAt', 'reviewedBy',
    'neutralRules', 'itemTopicOverrides',
  ];
  if (Object.keys(input).sort().join('\0') !== [...exactKeys].sort().join('\0')) {
    fail('artifact fields are incomplete or unknown');
  }
  if (input.schema !== 'md3.curriculum-item-dispositions/v2') fail('schema is unsupported');
  if (!Number.isInteger(input.revision) || (input.revision as number) < 1) {
    fail('revision must be a positive integer');
  }
  const reviewedAt = requiredString(input.reviewedAt, 'reviewedAt');
  if (!Number.isFinite(Date.parse(reviewedAt))) fail('reviewedAt must be an ISO timestamp');
  const reviewedBy = requiredString(input.reviewedBy, 'reviewedBy');
  if (!Array.isArray(input.neutralRules) || !Array.isArray(input.itemTopicOverrides)) {
    fail('rule and override collections must be arrays');
  }

  const neutralRules = input.neutralRules.map((raw, index): ReviewedNeutralRule => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`neutralRules[${index}] must be an object`);
    const row = raw as Record<string, unknown>;
    const inventory = row.inventory as ReviewedCurriculumInventory;
    const rotation = row.rotation as ReviewedMd3Rotation;
    const matchKind = row.matchKind as ReviewedNeutralMatchKind;
    const reason = row.reason as ReviewedNeutralReason;
    if (!INVENTORIES.has(inventory)) fail(`neutralRules[${index}].inventory is unknown`);
    if (!ROTATIONS.has(rotation)) fail(`neutralRules[${index}].rotation is unknown`);
    if (!MATCH_KINDS.has(matchKind)) fail(`neutralRules[${index}].matchKind is unknown`);
    if (!NEUTRAL_REASONS.has(reason)) fail(`neutralRules[${index}].reason is unknown`);
    const ruleValue = requiredString(row.value, `neutralRules[${index}].value`);
    return { inventory, rotation, matchKind, value: ruleValue, reason };
  });

  const itemTopicOverrides = input.itemTopicOverrides.map((raw, index): ReviewedItemTopicOverride => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`itemTopicOverrides[${index}] must be an object`);
    const row = raw as Record<string, unknown>;
    const inventory = row.inventory as ReviewedCurriculumInventory;
    const rotation = row.rotation as ReviewedMd3Rotation;
    if (!INVENTORIES.has(inventory)) fail(`itemTopicOverrides[${index}].inventory is unknown`);
    if (!ROTATIONS.has(rotation)) fail(`itemTopicOverrides[${index}].rotation is unknown`);
    return {
      inventory,
      rotation,
      itemId: requiredString(row.itemId, `itemTopicOverrides[${index}].itemId`),
      canonicalTopicIds: canonicalTopicIds(
        row.canonicalTopicIds,
        rotation,
        `itemTopicOverrides[${index}].canonicalTopicIds`,
      ),
    };
  });

  const unique = <T>(rows: readonly T[], key: (row: T) => string, label: string): void => {
    const seen = new Set<string>();
    for (const row of rows) {
      const candidate = key(row);
      if (seen.has(candidate)) fail(`duplicate ${label} ${candidate}`);
      seen.add(candidate);
    }
  };
  unique(neutralRules, row => `${row.inventory}\0${row.rotation}\0${row.matchKind}\0${row.value}`, 'neutral rule');
  unique(itemTopicOverrides, row => `${row.inventory}\0${row.rotation}\0${row.itemId}`, 'item override');

  const neutralIds = new Set(neutralRules.map(row => (
    `${row.inventory}\0${row.rotation}\0${row.value}`
  )));
  for (const override of itemTopicOverrides) {
    const key = `${override.inventory}\0${override.rotation}\0${override.itemId}`;
    if (neutralIds.has(key)) fail(`item is both topic-overridden and neutral ${key}`);
  }

  return {
    schema: input.schema,
    revision: input.revision as number,
    reviewedAt,
    reviewedBy,
    neutralRules,
    itemTopicOverrides,
  };
}

export const USYD_MD3_2026_ITEM_DISPOSITION_ARTIFACT = parseArtifact(rawArtifact);

function itemDispositionKey(
  inventory: ReviewedCurriculumInventory,
  rotation: ReviewedMd3Rotation,
  itemId: string,
): string {
  return `${inventory}\0${rotation}\0${itemId}`;
}

const ITEM_TOPIC_OVERRIDES_BY_KEY = new Map(
  USYD_MD3_2026_ITEM_DISPOSITION_ARTIFACT.itemTopicOverrides.map(override => [
    itemDispositionKey(override.inventory, override.rotation, override.itemId),
    override.canonicalTopicIds,
  ]),
);

const NEUTRAL_REASON_BY_KEY = new Map(
  USYD_MD3_2026_ITEM_DISPOSITION_ARTIFACT.neutralRules.map(rule => [
    itemDispositionKey(rule.inventory, rule.rotation, rule.value),
    rule.reason,
  ]),
);

export function resolveReviewedCurriculumItem(
  input: ResolveReviewedCurriculumItemInput,
): ResolvedReviewedCurriculumItem {
  const canonicalTopicIds = new Set(input.topics
    .map(topic => resolveReviewedMd3TopicAlias(input.rotation, topic))
    .filter((topic): topic is string => topic !== null));
  const key = itemDispositionKey(input.inventory, input.rotation, input.itemId);
  ITEM_TOPIC_OVERRIDES_BY_KEY.get(key)?.forEach(topic => canonicalTopicIds.add(topic));
  const sorted = [...canonicalTopicIds].sort();
  if (sorted.length > 0) return { canonicalTopicIds: sorted, reviewedNeutralReason: null };
  return {
    canonicalTopicIds: [],
    reviewedNeutralReason: NEUTRAL_REASON_BY_KEY.get(key) ?? null,
  };
}

export function compiledRuntimeCurriculumDispositionPolicy(
  rotation: ReviewedMd3Rotation,
): CompiledRuntimeCurriculumDispositionPolicy {
  const artifact = USYD_MD3_2026_ITEM_DISPOSITION_ARTIFACT;
  return {
    neutral_rules: artifact.neutralRules
      .filter(rule => rule.rotation === rotation)
      .map(rule => ({
        inventory: rule.inventory,
        match_kind: rule.matchKind,
        value: rule.value,
      })),
    item_topic_overrides: artifact.itemTopicOverrides
      .filter(override => override.rotation === rotation)
      .map(override => ({
        inventory: override.inventory,
        item_id: override.itemId,
        canonical_topic_ids: [...override.canonicalTopicIds],
      })),
  };
}
