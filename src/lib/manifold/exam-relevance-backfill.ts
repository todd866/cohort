import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  listCalibrationSources,
  loadCalibrationSource,
  summarizeExamSimilarities,
  type CalibrationLookupOpts,
  type CalibrationSourceInfo,
  type ExamSimilarity,
  type ScoreResult,
} from './exam-calibration';
import {
  scoreItemsAgainstCalibrationAnchors,
  type CalibrationAnchorInput,
} from './scoring';

export type ExamRelevanceItemKind = 'card' | 'question';
export type ExamRelevanceBackfillKind = ExamRelevanceItemKind | 'all';

export interface ExamRelevanceBackfillOptions {
  kind?: ExamRelevanceBackfillKind;
  cardLimit?: number;
  questionLimit?: number;
  rotation?: string;
  sourceKey?: string;
  calibrationRoot?: string;
  dryRun?: boolean;
  now?: Date;
}

export interface ExamRelevanceKindSummary {
  considered: number;
  scored: number;
  skippedNoSource: number;
  errors: string[];
}

export interface ExamRelevanceBackfillSummary {
  ok: boolean;
  dryRun: boolean;
  sourceCount: number;
  sourceKeys: string[];
  unroutedSourceKeys: string[];
  rotations: string[];
  cards: ExamRelevanceKindSummary;
  questions: ExamRelevanceKindSummary;
  durationMs: number;
}

interface ItemRow {
  id: string;
  rotation: string;
}

export interface ExamRelevanceMeta {
  version: 1;
  scoring: 'exam-calibration-v1';
  computedAt: string;
  itemType: ExamRelevanceItemKind;
  itemId: string;
  itemRotation: string;
  scope: {
    type: 'rotation' | 'source';
    rotation?: string;
    sourceKey?: string;
    sourceKeys: string[];
    sourceCount: number;
  };
  score: number;
  maxSourceScore: number;
  topDomains: ScoreResult['topDomains'];
  perSource: Record<string, number>;
}

export function resolveBackfillRotations(params: {
  sources: CalibrationSourceInfo[];
  requestedRotation?: string;
  sourceKey?: string;
}): string[] | null {
  const { sources, requestedRotation, sourceKey } = params;
  if (requestedRotation) return [requestedRotation];

  const declaredRotations = [...new Set(sources.map((s) => s.rotation).filter(Boolean) as string[])].sort();
  if (sourceKey) {
    return declaredRotations.length > 0 ? declaredRotations : null;
  }
  return declaredRotations;
}

export function buildExamRelevanceMeta(params: {
  itemType: ExamRelevanceItemKind;
  itemId: string;
  itemRotation: string;
  scopeType: 'rotation' | 'source';
  sourceKey?: string;
  sources: CalibrationSourceInfo[];
  scoreResult: ScoreResult;
  computedAt: Date;
}): ExamRelevanceMeta {
  const sourceKeys = params.sources.map((s) => s.sourceKey).sort();
  const sourceScores = Object.values(params.scoreResult.perSource);
  return {
    version: 1,
    scoring: 'exam-calibration-v1',
    computedAt: params.computedAt.toISOString(),
    itemType: params.itemType,
    itemId: params.itemId,
    itemRotation: params.itemRotation,
    scope: {
      type: params.scopeType,
      rotation: params.scopeType === 'rotation' ? params.itemRotation : undefined,
      sourceKey: params.sourceKey,
      sourceKeys,
      sourceCount: sourceKeys.length,
    },
    score: params.scoreResult.score,
    maxSourceScore: sourceScores.length > 0 ? Math.max(...sourceScores) : 0,
    topDomains: params.scoreResult.topDomains,
    perSource: params.scoreResult.perSource,
  };
}

function emptyKindSummary(): ExamRelevanceKindSummary {
  return {
    considered: 0,
    scored: 0,
    skippedNoSource: 0,
    errors: [],
  };
}

function sourceLookupOpts(options: ExamRelevanceBackfillOptions): CalibrationLookupOpts {
  return {
    calibrationRoot: options.calibrationRoot,
    sourceKey: options.sourceKey,
    rotation: options.sourceKey ? undefined : options.rotation,
  };
}

async function loadCardRows(limit: number, rotations: string[] | null): Promise<ItemRow[]> {
  if (limit <= 0) return [];
  const rotationFilter = rotations
    ? Prisma.sql`AND c.rotation = ANY(${rotations}::text[])`
    : Prisma.empty;

  return prisma.$queryRaw<ItemRow[]>`
    SELECT c.id, c.rotation
    FROM "Card" c
    JOIN card_embeddings ce ON ce.card_id = c.id
    WHERE c."deletedAt" IS NULL
      AND c."shelvedAt" IS NULL
      ${rotationFilter}
    ORDER BY c."examRelevanceUpdatedAt" ASC NULLS FIRST, c."createdAt" DESC
    LIMIT ${limit}::int
  `;
}

async function loadQuestionRows(limit: number, rotations: string[] | null): Promise<ItemRow[]> {
  if (limit <= 0) return [];
  const rotationFilter = rotations
    ? Prisma.sql`AND q.rotation = ANY(${rotations}::text[])`
    : Prisma.empty;

  return prisma.$queryRaw<ItemRow[]>`
    SELECT q.id, q.rotation
    FROM "Question" q
    JOIN question_embeddings qe ON qe.question_id = q.id
    WHERE q.excluded = false
      ${rotationFilter}
    ORDER BY q."examRelevanceUpdatedAt" ASC NULLS FIRST, q."createdAt" DESC
    LIMIT ${limit}::int
  `;
}

async function persistScore(
  itemType: ExamRelevanceItemKind,
  id: string,
  score: number,
  meta: ExamRelevanceMeta,
  computedAt: Date,
): Promise<void> {
  const metaJson = JSON.stringify(meta);
  if (itemType === 'card') {
    await prisma.$executeRaw`
      UPDATE "Card"
      SET "examRelevance" = ${score}::double precision,
          "examRelevanceMeta" = ${metaJson}::jsonb,
          "examRelevanceUpdatedAt" = ${computedAt}
      WHERE id = ${id}
    `;
    return;
  }

  await prisma.$executeRaw`
    UPDATE "Question"
    SET "examRelevance" = ${score}::double precision,
        "examRelevanceMeta" = ${metaJson}::jsonb,
        "examRelevanceUpdatedAt" = ${computedAt}
    WHERE id = ${id}
  `;
}

function buildCalibrationAnchors(
  sources: CalibrationSourceInfo[],
  options: ExamRelevanceBackfillOptions,
): CalibrationAnchorInput[] {
  const anchors: CalibrationAnchorInput[] = [];
  for (const source of sources) {
    const data = loadCalibrationSource(source.sourceKey, {
      calibrationRoot: options.calibrationRoot,
    });
    if (!data) continue;
    for (const topic of data.topics) {
      anchors.push({
        sourceKey: source.sourceKey,
        domain: topic.domain,
        embedding: topic.embedding,
      });
    }
  }
  return anchors;
}

interface ScoringGroup {
  rows: ItemRow[];
  sources: CalibrationSourceInfo[];
}

async function scoreRows(params: {
  itemType: ExamRelevanceItemKind;
  rows: ItemRow[];
  options: ExamRelevanceBackfillOptions;
  computedAt: Date;
}): Promise<ExamRelevanceKindSummary> {
  const summary = emptyKindSummary();
  summary.considered = params.rows.length;

  const sourcesByRotation = new Map<string, CalibrationSourceInfo[]>();
  const groups = new Map<string, ScoringGroup>();
  const sourceKeySources = params.options.sourceKey
    ? listCalibrationSources({
        calibrationRoot: params.options.calibrationRoot,
        sourceKey: params.options.sourceKey,
      })
    : null;

  for (const row of params.rows) {
    const sources = sourceKeySources
      ?? sourcesByRotation.get(row.rotation)
      ?? listCalibrationSources({
        calibrationRoot: params.options.calibrationRoot,
        rotation: row.rotation,
      });

    if (!sourceKeySources && !sourcesByRotation.has(row.rotation)) {
      sourcesByRotation.set(row.rotation, sources);
    }

    if (sources.length === 0) {
      summary.skippedNoSource += 1;
      continue;
    }

    const groupKey = params.options.sourceKey ? `source:${params.options.sourceKey}` : `rotation:${row.rotation}`;
    const group = groups.get(groupKey) ?? { rows: [], sources };
    group.rows.push(row);
    groups.set(groupKey, group);
  }

  const itemTable = params.itemType === 'card' ? 'card_embeddings' : 'question_embeddings';
  const itemIdColumn = params.itemType === 'card' ? 'card_id' : 'question_id';

  for (const [groupKey, group] of groups) {
    try {
      const anchors = buildCalibrationAnchors(group.sources, params.options);
      if (anchors.length === 0) {
        summary.skippedNoSource += group.rows.length;
        continue;
      }

      const scalarRows = await scoreItemsAgainstCalibrationAnchors({
        itemTable,
        itemIdColumn,
        itemIds: group.rows.map((row) => row.id),
        anchors,
      });

      const similaritiesByItem = new Map<string, ExamSimilarity[]>();
      for (const scalar of scalarRows) {
        const similarities = similaritiesByItem.get(scalar.item_id) ?? [];
        similarities.push({
          sourceKey: scalar.source_key,
          domain: scalar.domain,
          similarity: Number(scalar.similarity),
        });
        similaritiesByItem.set(scalar.item_id, similarities);
      }

      for (const row of group.rows) {
        const scoreResult = summarizeExamSimilarities(
          similaritiesByItem.get(row.id) ?? [],
          group.sources.map((source) => source.sourceKey),
        );
        const meta = buildExamRelevanceMeta({
          itemType: params.itemType,
          itemId: row.id,
          itemRotation: row.rotation,
          scopeType: params.options.sourceKey ? 'source' : 'rotation',
          sourceKey: params.options.sourceKey,
          sources: group.sources,
          scoreResult,
          computedAt: params.computedAt,
        });

        if (!params.options.dryRun) {
          await persistScore(params.itemType, row.id, scoreResult.score, meta, params.computedAt);
        }
        summary.scored += 1;
      }
    } catch (error) {
      summary.errors.push(`${params.itemType} ${groupKey}: ${String(error)}`);
    }
  }

  return summary;
}

export async function backfillExamRelevanceBatch(
  options: ExamRelevanceBackfillOptions = {},
): Promise<ExamRelevanceBackfillSummary> {
  const startedAt = Date.now();
  const kind = options.kind ?? 'all';
  const cardLimit = options.cardLimit ?? 500;
  const questionLimit = options.questionLimit ?? 250;
  const computedAt = options.now ?? new Date();

  const sources = listCalibrationSources(sourceLookupOpts(options));
  const rotations = resolveBackfillRotations({
    sources,
    requestedRotation: options.rotation,
    sourceKey: options.sourceKey,
  });

  const summary: ExamRelevanceBackfillSummary = {
    ok: true,
    dryRun: options.dryRun ?? false,
    sourceCount: sources.length,
    sourceKeys: sources.map((s) => s.sourceKey).sort(),
    unroutedSourceKeys: sources.filter((s) => !s.rotation).map((s) => s.sourceKey).sort(),
    rotations: rotations ? rotations : ['*'],
    cards: emptyKindSummary(),
    questions: emptyKindSummary(),
    durationMs: 0,
  };

  if (sources.length === 0 || (rotations?.length === 0)) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  if (kind === 'card' || kind === 'all') {
    const rows = await loadCardRows(cardLimit, rotations);
    summary.cards = await scoreRows({
      itemType: 'card',
      rows,
      options,
      computedAt,
    });
  }

  if (kind === 'question' || kind === 'all') {
    const rows = await loadQuestionRows(questionLimit, rotations);
    summary.questions = await scoreRows({
      itemType: 'question',
      rows,
      options,
      computedAt,
    });
  }

  summary.durationMs = Date.now() - startedAt;
  summary.ok = summary.cards.errors.length === 0 && summary.questions.errors.length === 0;
  return summary;
}
