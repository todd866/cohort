import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { findManyCards, ownerPrivateOrSharedCardScope } from '@/lib/cards/read-repository.server';
import { withoutRawPublicUsmleQuestions } from '@/lib/usmle/raw-question-boundary';
import { withDefaultQuestionServingPolicy } from '@/lib/questions/source-policy';
import { userIdCanAccessPrivateSources } from '@/lib/questions/private-access';
import { userIdCanAccessRequestedRotations } from '@/lib/personal-rotation-access';
import { isSessionCandidateItem } from '@/lib/knowledge/session-candidate-scope';
import { EXCLUDED_POOL_TOPICS } from './servable-pool';
import type { UnifiedItem, SessionContext } from './unified-session-types';

/** Clinical bodies are current database state, never a bundled/cache fallback. */
export const CURRENT_QUESTION_CONTENT_SELECT = {
  stem: true, options: true, context: true, combinations: true, correctVariants: true,
  abbreviations: true,
  difficulty: true, variantGroupId: true, variantType: true,
} as const;
export const CURRENT_CARD_CONTENT_SELECT = {
  front: true, back: true, backs: true, context: true, crosslinks: true,
  abbreviations: true,
  sourceComponent: true, complexity: true, difficulty: true, clusterId: true,
  variantGroupId: true, variantIndex: true, variantType: true,
  // Overlay key for the repetition-slot shadow. Same selected-id read.
  stableId: true,
} as const;

export type CurrentContentContext = Pick<SessionContext, 'userId' | 'rotation' | 'practiceLocale' | 'weekFilter'> & Partial<Pick<
  SessionContext, 'crossSourceRotations' | 'crossSourceMappingMode'
>>;
export type CurrentQuestionRow = {
  stem: string;
  options: unknown;
  combinations: unknown;
  correctVariants: unknown;
  difficulty: string;
  variantGroupId: string | null;
  variantType: string | null;
  concepts?: Array<{ conceptId: string }>;
  id: string;
  rotation: string;
  week: number | null;
  moduleNodes: string[];
  source: string;
  sourceFile: string | null;
  contentState: string;
  excluded: boolean;
  context: string | null;
  abbreviations?: unknown;
  topics: string[];
  practiceLocale: string | null;
  imageUrl: string | null;
  imageCaption: string | null;
  imageRole: string | null;
  clipId: string | null;
  clipRole: string | null;
  clipCaption: string | null;
};

export type CurrentCardRow = {
  front: string;
  back: string;
  backs: unknown;
  context: string | null;
  abbreviations?: unknown;
  crosslinks: unknown;
  complexity: number;
  difficulty: string;
  clusterId: string | null;
  variantGroupId: string | null;
  variantIndex: number | null;
  variantType: string | null;
  stableId: string | null;
  id: string;
  rotation: string;
  week: number | null;
  moduleNodes: string[];
  sourceFile: string | null;
  sourceComponent: string;
  ownerUserId: string | null;
  studyDeckId: string | null;
  importEpochId: string | null;
  deletedAt: Date | null;
  shelvedAt: Date | null;
  topics: string[];
  practiceLocale: string | null;
  imageUrl: string | null;
  imageCaption: string | null;
  imageRole: string | null;
  clipId: string | null;
  clipRole: string | null;
  clipCaption: string | null;
};

/**
 * Convert Prisma JSON to the narrow client contract. Content rows are external
 * data at this boundary, so malformed entries must not make a whole review
 * batch fail or leak non-string values into the renderer.
 */
export function normalizeAbbreviations(value: unknown): Record<string, string> | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return {};
  const rawEntries = Object.entries(value as Record<string, unknown>);
  if (rawEntries.length === 0) return {};
  const entries = rawEntries.flatMap(([key, expansion]) => {
    if (!key.trim() || typeof expansion !== 'string' || !expansion.trim()) return [];
    return [[key, expansion.trim()] as const];
  });
  // An explicit empty object is authoritative: it means this item was
  // checked and intentionally has no decodes. Preserve that distinction from
  // null/undefined, which means the item has not been migrated yet.
  return Object.fromEntries(entries);
}


export type CurrentSessionSource =
  | ({ type: 'question' } & CurrentQuestionRow)
  | ({ type: 'card' } & CurrentCardRow);

export function sessionSourceKey(type: 'question' | 'card', id: string): string {
  return `${type}:${id}`;
}

function currentSourceIsSessionCandidate(ctx: CurrentContentContext, source: CurrentSessionSource): boolean {
  return (ctx.weekFilter === null || source.week === ctx.weekFilter)
    && (source.practiceLocale == null || source.practiceLocale === ctx.practiceLocale) && isSessionCandidateItem(
    source.rotation, source.moduleNodes, ctx.rotation,
    ctx.crossSourceRotations ?? [], ctx.crossSourceMappingMode ?? 'adjacent',
  );
}

/** Replace related body fields together; explicit nulls erase obsolete content. */
export function withCurrentSessionBody(item: UnifiedItem, source: CurrentSessionSource): UnifiedItem {
  if (source.type === 'question') {
    return { ...item, stem: source.stem, context: source.context,
      explanation: source.context, topics: source.topics, difficulty: source.difficulty,
      abbreviations: normalizeAbbreviations(source.abbreviations),
      variantGroupId: source.variantGroupId, variantType: source.variantType,
      clipRole: source.clipRole === 'prompt' ? 'prompt' : null,
      clipCaption: source.clipCaption ?? null,
    };
  }
  return { ...item, front: source.front, back: source.back,
    backs: source.backs as UnifiedItem['backs'], context: source.context,
    crosslinks: source.crosslinks as UnifiedItem['crosslinks'],
    sourceComponent: source.sourceComponent, topics: source.topics,
    abbreviations: normalizeAbbreviations(source.abbreviations),
    complexity: source.complexity, difficulty: source.difficulty, clusterId: source.clusterId,
    variantGroupId: source.variantGroupId, variantIndex: source.variantIndex, variantType: source.variantType,
    clipRole: source.clipRole === 'prompt' ? 'prompt' : null,
    clipCaption: source.clipCaption ?? null,
  };
}

/** Selected-ID point reads only. Each model fails closed independently. */
export async function loadCurrentSessionContent(
  ctx: CurrentContentContext,
  items: ReadonlyArray<Pick<UnifiedItem, 'type' | 'id'>>,
  options: { includeQuestionConcepts?: boolean } = {},
): Promise<Map<string, CurrentSessionSource>> {
  const questionIds = [...new Set(items
    .filter((item) => item.type === 'question')
    .map((item) => item.id)
    .filter(Boolean))];
  const cardIds = [...new Set(items
    .filter((item) => item.type === 'card')
    .map((item) => item.id)
    .filter(Boolean))];
  const allowPrivateSources = questionIds.length > 0
    ? await userIdCanAccessPrivateSources(ctx.userId).catch(() => false)
    : false;

  const questionWhere = withDefaultQuestionServingPolicy(
    withoutRawPublicUsmleQuestions({
      id: { in: questionIds },
      ...(ctx.weekFilter !== null ? { week: ctx.weekFilter } : {}),
      excluded: false,
      NOT: { topics: { hasSome: [...EXCLUDED_POOL_TOPICS] } },
      OR: [{ practiceLocale: null }, { practiceLocale: ctx.practiceLocale }],
    }),
    { allowPrivateSources },
  );
  const [questionResult, cardResult] = await Promise.allSettled([
    questionIds.length > 0
      ? prisma.question.findMany({
          where: questionWhere,
          select: {
            id: true,
            rotation: true,
            week: true,
            moduleNodes: true,
            source: true,
            sourceFile: true,
            contentState: true,
            excluded: true,
            ...CURRENT_QUESTION_CONTENT_SELECT,
            ...(options.includeQuestionConcepts ? { concepts: { where: { isPrimary: true }, select: { conceptId: true }, take: 2, orderBy: { conceptId: 'asc' as const } } } : {}),
            topics: true,
            practiceLocale: true,
            imageUrl: true,
            imageCaption: true,
            imageRole: true,
            clipId: true,
            clipRole: true,
            clipCaption: true,
          },
        })
      : Promise.resolve([] as CurrentQuestionRow[]),
    cardIds.length > 0
      ? findManyCards(ownerPrivateOrSharedCardScope(ctx.userId), {
          where: {
            id: { in: cardIds },
            ...(ctx.weekFilter !== null ? { week: ctx.weekFilter } : {}),
            deletedAt: null,
            shelvedAt: null,
            NOT: { topics: { hasSome: [...EXCLUDED_POOL_TOPICS] } },
            OR: [{ practiceLocale: null }, { practiceLocale: ctx.practiceLocale }],
          },
          select: {
            id: true,
            rotation: true,
            week: true,
            moduleNodes: true,
            sourceFile: true,
            ...CURRENT_CARD_CONTENT_SELECT,
            ownerUserId: true,
            studyDeckId: true,
            importEpochId: true,
            deletedAt: true,
            shelvedAt: true,
            topics: true,
            practiceLocale: true,
            imageUrl: true,
            imageCaption: true,
            imageRole: true,
            clipId: true,
            clipRole: true,
            clipCaption: true,
          },
        })
      : Promise.resolve([] as CurrentCardRow[]),
  ]);

  if (questionResult.status === 'rejected') {
    logger.error('Current question lookup failed; dropping selected questions', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      error: String(questionResult.reason),
    });
  }
  if (cardResult.status === 'rejected') {
    logger.error('Current card lookup failed; dropping selected cards', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      error: String(cardResult.reason),
    });
  }

  const sources = new Map<string, CurrentSessionSource>();
  if (questionResult.status === 'fulfilled') {
    for (const row of questionResult.value as CurrentQuestionRow[]) {
      sources.set(sessionSourceKey('question', row.id), {
        type: 'question', ...row, abbreviations: normalizeAbbreviations(row.abbreviations),
      });
    }
  }
  if (cardResult.status === 'fulfilled') {
    for (const row of cardResult.value as CurrentCardRow[]) {
      sources.set(sessionSourceKey('card', row.id), {
        type: 'card', ...row, abbreviations: normalizeAbbreviations(row.abbreviations),
      });
    }
  }

  const candidateSources = [...sources.values()].filter((source) =>
    currentSourceIsSessionCandidate(ctx, source));
  const accessByRotation = new Map<string, boolean>();
  await Promise.all([...new Set(candidateSources.map((source) => source.rotation))].map(async (rotation) => {
    const allowed = await userIdCanAccessRequestedRotations(ctx.userId, [rotation]).catch(() => false);
    accessByRotation.set(rotation, allowed);
  }));
  return new Map(candidateSources
    .filter((source) => accessByRotation.get(source.rotation) === true)
    .filter((source) => source.imageRole === null || source.imageRole === 'prompt')
    .map((source) => [sessionSourceKey(source.type, source.id), source]));
}
