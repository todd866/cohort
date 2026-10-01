import { examTargetVersionId } from './contract';
import { computeItemTargetIndex } from './scoring';
import type { ExamTargetDefinition, ExamTargetRotation } from './types';

export type ExamTargetSnapshotItemType = 'card' | 'question';
export type ExamTargetAssignmentMethod = 'curated' | 'centroid';
export type ExamTargetConceptMappingMethod =
  | 'reviewed'
  | 'capped-linked-item-draft';

export interface EligibleExamTargetConceptFact {
  conceptId: string;
  domainMix: Readonly<Record<string, number>>;
  primaryDomainCode: string;
  mappingMethod: ExamTargetConceptMappingMethod;
  mappingConfidence: number;
  mappingHash: string;
  artifactHash: string;
}

export interface CompiledExamTargetConceptRow
  extends EligibleExamTargetConceptFact {
  domainMix: Readonly<Record<string, number>>;
  targetIndex: number;
}

/** Persisted assignment evidence required to reproduce an item-sidecar row. */
export interface ExamTargetAssignmentAudit {
  assignmentMethod: ExamTargetAssignmentMethod;
  rawSimilarity: number | null;
  zSimilarity: number | null;
  runnerUpDomainCode: string | null;
  assignmentMargin: number | null;
}

interface EligibleExamTargetItemBase {
  itemType: ExamTargetSnapshotItemType;
  id: string;
  sourceRotation: string;
  targetRotation?: string | null;
  embeddingHash: string;
}

export interface MappedEligibleExamTargetItemFact
  extends EligibleExamTargetItemBase, ExamTargetAssignmentAudit {
  domainCode: string;
  fitPercentile: number | null;
  assignmentConfidence: number;
  geometryConfidence: number;
}

export interface UnmappedEligibleExamTargetItemFact
  extends EligibleExamTargetItemBase {
  domainCode: null;
  assignmentMethod: null;
  rawSimilarity: null;
  zSimilarity: null;
  runnerUpDomainCode: null;
  assignmentMargin: null;
  fitPercentile: null;
  assignmentConfidence: 0;
  geometryConfidence: 0;
}

export type EligibleExamTargetItemFact =
  | MappedEligibleExamTargetItemFact
  | UnmappedEligibleExamTargetItemFact;

export interface CompiledExamTargetItemRow extends ExamTargetAssignmentAudit {
  itemKey: string;
  itemType: ExamTargetSnapshotItemType;
  itemId: string;
  sourceRotation: string;
  targetRotation: ExamTargetRotation;
  embeddingHash: string;
  domainCode: string;
  fitPercentile: number | null;
  assignmentConfidence: number;
  geometryConfidence: number;
  effectiveDomainWeight: number;
  maxDomainWeight: number;
  weightProvenance:
    | 'official-question-count'
    | 'proxy-shrunk-anchor-share';
  domainPriorityIndex: number;
  itemTargetIndex: number;
}

export interface ExamTargetDomainCoverage {
  domainCode: string;
  effectiveDomainWeight: number;
  mappedItemCount: number;
  coverageStatus: 'covered' | 'missing';
}

export interface ExamTargetItemTypeCoverage {
  itemType: ExamTargetSnapshotItemType;
  eligibleItemCount: number;
  mappedItemCount: number;
  unmappedItemCount: number;
  unmappedItemKeys: readonly string[];
  coveredTargetWeight: number;
  missingTargetWeight: number;
  domains: readonly ExamTargetDomainCoverage[];
}

export interface ExamTargetSnapshotCoverage {
  eligibleItemCount: number;
  scoredItemCount: number;
  unmappedItemCount: number;
  byItemType: readonly ExamTargetItemTypeCoverage[];
}

export interface CompiledExamTargetSnapshot {
  targetId: string;
  revision: number;
  targetVersion: string;
  targetRotation: ExamTargetRotation;
  scorerVersion: string;
  itemRows: readonly CompiledExamTargetItemRow[];
  conceptRows: readonly CompiledExamTargetConceptRow[];
  coverage: ExamTargetSnapshotCoverage;
}

export interface CompileExamTargetSnapshotInput {
  /** Must already have passed the exam-target definition contract. */
  definition: ExamTargetDefinition;
  items: readonly EligibleExamTargetItemFact[];
  /** Omitted only for backwards-compatible dry-run coverage audits. */
  concepts?: readonly EligibleExamTargetConceptFact[];
}

const ITEM_TYPES = ['card', 'question'] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const DOMAIN_MIX_EPSILON = 1e-9;

function itemKey(item: Pick<EligibleExamTargetItemFact, 'itemType' | 'id'>): string {
  return `${item.itemType}:${item.id}`;
}

function stableStringCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function compileExamTargetSnapshot(
  input: CompileExamTargetSnapshotInput,
): CompiledExamTargetSnapshot {
  const domains = [...input.definition.domains].sort((left, right) =>
    left.code.localeCompare(right.code),
  );
  const domainByCode = new Map(domains.map((domain) => [domain.code, domain]));
  const maxDomainWeight = Math.max(
    ...domains.map((domain) => domain.effectiveWeight),
  );
  const sortedItems = [...input.items].sort((left, right) =>
    itemKey(left).localeCompare(itemKey(right)),
  );

  const seenItemKeys = new Set<string>();
  for (const item of sortedItems) {
    if (!item.id.trim()) {
      throw new Error('item id must be non-empty');
    }
    const key = itemKey(item);
    if (!item.sourceRotation.trim()) {
      throw new Error(`sourceRotation must be non-empty for ${key}`);
    }
    if (item.targetRotation !== input.definition.rotation) {
      throw new Error(
        `targetRotation must equal ${input.definition.rotation} for ${key}`,
      );
    }
    if (seenItemKeys.has(key)) {
      throw new Error(`duplicate item key ${key}`);
    }
    seenItemKeys.add(key);
    if (item.domainCode != null && !domainByCode.has(item.domainCode)) {
      throw new Error(`unknown domainCode ${item.domainCode} for ${key}`);
    }
    if (item.domainCode != null && item.runnerUpDomainCode === item.domainCode) {
      throw new Error(`runnerUpDomainCode must differ from domainCode for ${key}`);
    }
    if (
      item.domainCode != null
      && item.runnerUpDomainCode != null
      && !domainByCode.has(item.runnerUpDomainCode)
    ) {
      throw new Error(
        `unknown runnerUpDomainCode ${item.runnerUpDomainCode} for ${key}`,
      );
    }
    if (
      item.domainCode != null
      && item.rawSimilarity !== null
      && !Number.isFinite(item.rawSimilarity)
    ) {
      throw new Error(`invalid rawSimilarity for ${key}`);
    }
    if (
      item.domainCode != null
      && item.zSimilarity !== null
      && !Number.isFinite(item.zSimilarity)
    ) {
      throw new Error(`invalid zSimilarity for ${key}`);
    }
    if (
      item.domainCode != null
      && item.assignmentMargin !== null
      && (
        !Number.isFinite(item.assignmentMargin)
        || item.assignmentMargin < 0
      )
    ) {
      throw new Error(`invalid assignmentMargin for ${key}`);
    }
    if (!SHA256.test(item.embeddingHash)) {
      throw new Error(`embeddingHash must be lowercase SHA-256 for ${key}`);
    }
    if (
      item.fitPercentile !== null
      && (
        !Number.isFinite(item.fitPercentile)
        || item.fitPercentile < 0
        || item.fitPercentile > 1
      )
    ) {
      throw new Error(`invalid fitPercentile for ${key}`);
    }
    if (
      !Number.isFinite(item.assignmentConfidence)
      || item.assignmentConfidence < 0
      || item.assignmentConfidence > 1
    ) {
      throw new Error(`invalid assignmentConfidence for ${key}`);
    }
    if (
      !Number.isFinite(item.geometryConfidence)
      || item.geometryConfidence < 0
      || item.geometryConfidence > 1
    ) {
      throw new Error(`invalid geometryConfidence for ${key}`);
    }
  }

  const concepts = input.concepts ?? [];
  if (!Array.isArray(concepts)) {
    throw new Error('concepts must be an array');
  }
  const seenConceptIds = new Set<string>();
  const conceptRows = concepts.map((concept): CompiledExamTargetConceptRow => {
    if (
      typeof concept.conceptId !== 'string'
      || concept.conceptId.trim().length === 0
      || concept.conceptId.length > 191
    ) {
      throw new Error('conceptId must be a non-empty stable identifier');
    }
    if (seenConceptIds.has(concept.conceptId)) {
      throw new Error(`duplicate conceptId ${concept.conceptId}`);
    }
    seenConceptIds.add(concept.conceptId);
    if (!isPlainRecord(concept.domainMix)) {
      throw new Error(`invalid domainMix for ${concept.conceptId}`);
    }
    const mixEntries = Object.entries(concept.domainMix).sort(
      ([left], [right]) => stableStringCompare(left, right),
    );
    if (mixEntries.length === 0) {
      throw new Error(`domainMix must be non-empty for ${concept.conceptId}`);
    }
    let totalMass = 0;
    const canonicalDomainMix: Record<string, number> = {};
    const validatedMixEntries: Array<readonly [string, number]> = [];
    for (const [domainCode, rawMass] of mixEntries) {
      if (!domainByCode.has(domainCode)) {
        throw new Error(
          `unknown domainCode ${domainCode} in domainMix for ${concept.conceptId}`,
        );
      }
      if (
        typeof rawMass !== 'number'
        || !Number.isFinite(rawMass)
        || rawMass < 0
        || rawMass > 1
      ) {
        throw new Error(`invalid domainMix mass for ${concept.conceptId}`);
      }
      canonicalDomainMix[domainCode] = rawMass;
      validatedMixEntries.push([domainCode, rawMass]);
      totalMass += rawMass;
    }
    if (Math.abs(totalMass - 1) > DOMAIN_MIX_EPSILON) {
      throw new Error(`domainMix must sum to 1 for ${concept.conceptId}`);
    }
    if (
      !domainByCode.has(concept.primaryDomainCode)
      || !(canonicalDomainMix[concept.primaryDomainCode] > 0)
    ) {
      throw new Error(`invalid primaryDomainCode for ${concept.conceptId}`);
    }
    const deterministicPrimary = validatedMixEntries.reduce((best, entry) =>
      entry[1] > best[1] ? entry : best,
    )[0];
    if (concept.primaryDomainCode !== deterministicPrimary) {
      throw new Error(
        `primaryDomainCode must be deterministic maximum for ${concept.conceptId}`,
      );
    }
    if (
      concept.mappingMethod !== 'reviewed'
      && concept.mappingMethod !== 'capped-linked-item-draft'
    ) {
      throw new Error(`invalid mappingMethod for ${concept.conceptId}`);
    }
    if (
      !Number.isFinite(concept.mappingConfidence)
      || concept.mappingConfidence < 0
      || concept.mappingConfidence > 1
    ) {
      throw new Error(`invalid mappingConfidence for ${concept.conceptId}`);
    }
    if (!SHA256.test(concept.mappingHash)) {
      throw new Error(`mappingHash must be lowercase SHA-256 for ${concept.conceptId}`);
    }
    if (!SHA256.test(concept.artifactHash)) {
      throw new Error(`artifactHash must be lowercase SHA-256 for ${concept.conceptId}`);
    }
    const weightedDomainPriority = validatedMixEntries.reduce(
      (total, [domainCode, mass]) =>
        total + mass * domainByCode.get(domainCode)!.effectiveWeight / maxDomainWeight,
      0,
    );
    // Preserve the reviewed mixture exactly while making tolerated floating
    // normalization error immaterial to the persisted unit-scale score.
    const targetIndex = weightedDomainPriority / totalMass;
    return {
      conceptId: concept.conceptId,
      domainMix: canonicalDomainMix,
      primaryDomainCode: concept.primaryDomainCode,
      mappingMethod: concept.mappingMethod,
      mappingConfidence: concept.mappingConfidence,
      mappingHash: concept.mappingHash,
      artifactHash: concept.artifactHash,
      targetIndex,
    };
  }).sort((left, right) => stableStringCompare(left.conceptId, right.conceptId));

  const itemRows = sortedItems.flatMap((item): CompiledExamTargetItemRow[] => {
    if (item.domainCode == null) return [];
    const domain = domainByCode.get(item.domainCode)!;
    const itemTargetIndex = computeItemTargetIndex({
      effectiveDomainWeight: domain.effectiveWeight,
      maxDomainWeight,
      fitPercentile: item.fitPercentile,
      geometryConfidence: item.geometryConfidence,
      assignmentConfidence: item.assignmentConfidence,
    });
    if (itemTargetIndex == null) {
      throw new Error(`unable to score ${itemKey(item)}`);
    }

    return [{
      itemKey: itemKey(item),
      itemType: item.itemType,
      itemId: item.id,
      sourceRotation: item.sourceRotation,
      targetRotation: input.definition.rotation,
      embeddingHash: item.embeddingHash,
      domainCode: domain.code,
      assignmentMethod: item.assignmentMethod,
      rawSimilarity: item.rawSimilarity,
      zSimilarity: item.zSimilarity,
      runnerUpDomainCode: item.runnerUpDomainCode,
      assignmentMargin: item.assignmentMargin,
      fitPercentile: item.fitPercentile,
      assignmentConfidence: item.assignmentConfidence,
      geometryConfidence: item.geometryConfidence,
      effectiveDomainWeight: domain.effectiveWeight,
      maxDomainWeight,
      weightProvenance: domain.weightAuthority === 'official'
        ? 'official-question-count'
        : 'proxy-shrunk-anchor-share',
      domainPriorityIndex: domain.effectiveWeight / maxDomainWeight,
      itemTargetIndex,
    }];
  });

  const byItemType = ITEM_TYPES.map((type): ExamTargetItemTypeCoverage => {
    const eligible = sortedItems.filter((item) => item.itemType === type);
    const mappedRows = itemRows.filter((row) => row.itemType === type);
    const unmappedItemKeys = eligible
      .filter((item) => item.domainCode == null)
      .map(itemKey);
    const domainCoverage = domains.map((domain): ExamTargetDomainCoverage => {
      const mappedItemCount = mappedRows.filter(
        (row) => row.domainCode === domain.code,
      ).length;
      return {
        domainCode: domain.code,
        effectiveDomainWeight: domain.effectiveWeight,
        mappedItemCount,
        coverageStatus: mappedItemCount > 0 ? 'covered' : 'missing',
      };
    });

    return {
      itemType: type,
      eligibleItemCount: eligible.length,
      mappedItemCount: mappedRows.length,
      unmappedItemCount: unmappedItemKeys.length,
      unmappedItemKeys,
      coveredTargetWeight: domainCoverage
        .filter((domain) => domain.coverageStatus === 'covered')
        .reduce((sum, domain) => sum + domain.effectiveDomainWeight, 0),
      missingTargetWeight: domainCoverage
        .filter((domain) => domain.coverageStatus === 'missing')
        .reduce((sum, domain) => sum + domain.effectiveDomainWeight, 0),
      domains: domainCoverage,
    };
  });

  return deepFreeze({
    targetId: input.definition.targetId,
    revision: input.definition.revision,
    targetVersion: examTargetVersionId(input.definition),
    targetRotation: input.definition.rotation,
    scorerVersion: input.definition.scoringPolicyVersion,
    itemRows,
    conceptRows,
    coverage: {
      eligibleItemCount: sortedItems.length,
      scoredItemCount: itemRows.length,
      unmappedItemCount: sortedItems.length - itemRows.length,
      byItemType,
    },
  });
}
