import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { embedContent, formatCardForEmbedding, findCardsForQuestion } from '@/lib/manifold';
import { prependCardsToQueue } from '@/lib/study-queue';
import { mcqToCloze, shouldOmitMcqCard, shouldSkipClozeConversion, trimAnswerForCloze } from '@/lib/mcq-to-cloze';
import { isRawPublicUsmleQuestionIdentity } from '@/lib/usmle/raw-question-boundary';
import { Prisma } from '@prisma/client';

type ScorableOption = { label: string; text: string; isCorrect: boolean };
type ReinforcementOptions = {
  maxExtraCards?: number;
  embed?: boolean;
};

export const REINFORCEMENT_STABLE_ID_PREFIX = 'qcard:';
const REINFORCEMENT_INSERT_OFFSET = 6;
const REINFORCEMENT_MAX_ITEMS = 2;
const REINFORCEMENT_MAX_EXTRA_CARDS = 2;

// Patterns that mark a question as needing the MCQ options visible to be
// answerable. As QR-card fronts, these stems give the student no way to
// discriminate between candidates. Singular-answer recall ("Which drug is
// this describing?", "Which artery supplies X?") is fine — only catch:
//   1. "Which of the following / these"
//   2. Discriminator forms: "Which X is FALSE / incorrect / MOST / LEAST"
//   3. Negation forms: "Which Y would NOT..."
//   4. Open plural-noun list questions: "Which factors / features / criteria..."
const STEM_REQUIRES_OPTIONS = [
  /\bwhich\s+of\s+(?:the\s+following|these)\b/i,
  /\bwhich\s+statement\s+is\b/i,
  /\bwhich\s+(?:\w+\s+){0,4}is\s+(?:false|incorrect|untrue|wrong)\b/i,
  /\bwhich\s+\w+\s+would\s+not\b/i,
  /\bwhich\s+(?:features|factors|symptoms|signs|findings|complications|side[-\s]effects|risk\s+factors|criteria)\b/i,
  // Ordered-list questions ("In what order do X develop?", "What is the
  // correct sequence?", "Rank the following...") need the option list
  // visible — the answer is a multi-element ordering that doesn't fit a
  // 1-2 word cloze.
  /\bin\s+what\s+order\b/i,
  /\bwhat\s+is\s+the\s+(?:correct\s+)?(?:order|sequence)\b/i,
  /\brank\s+the\s+following\b/i,
];

function stemRequiresOptions(stem: string): boolean {
  return STEM_REQUIRES_OPTIONS.some((re) => re.test(stem));
}

// "See per-option explanations." is a valid context on the MCQ side (the
// per-option explanations are visible there) but meaningless on a derived
// QR flashcard where the options aren't shown. Treat it as no context.
const STUB_CONTEXT = /^(?:see\s+per[-\s]option(?:\s+explanations?)?|see\s+options?|see\s+(?:above|below)|see\s+explanations?|n\/?a)\.?\s*$/i;
export function normalizeContextForCard(context: string | null): string | null {
  if (!context) return null;
  const trimmed = context.trim();
  if (trimmed.length < 60 && STUB_CONTEXT.test(trimmed)) return null;
  return context;
}

export type PrimaryCardDraft = {
  cardType: 'cloze';
  rotation: string;
  week: number;
  sourceComponent: 'QuestionReinforcement';
  stableId: string;
  front: string;
  back: string;
  context: string | null;
  topics: string[];
  difficulty: string;
  crosslinks: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined;
  imageUrl: string | null;
  imageCaption: string | null;
  /**
   * True when the cloze blank came from a hand-authored `correctVariants`
   * entry (curator opted in to cloze form) rather than the raw correct
   * option text. Used to safely allow new QR card creation — pure
   * procedural conversion can produce structurally bad cards, but
   * curator-vetted variants are reliable.
   */
  curated: boolean;
};

export type ExistingPrimaryCard = {
  id: string;
  stableId: string | null;
  cardType: string;
  rotation: string;
  week: number | null;
  sourceComponent: string;
  front: string;
  back: string;
  context: string | null;
  topics: string[];
  difficulty: string;
  crosslinks: Prisma.JsonValue | null;
  imageUrl: string | null;
  imageCaption: string | null;
};

function coerceScorableOptions(options: unknown): ScorableOption[] {
  if (!Array.isArray(options)) return [];
  return (options as Array<{ label?: unknown; text?: unknown; isCorrect?: unknown }>)
    .map((o) => ({
      label: typeof o.label === 'string' ? o.label : null,
      text: typeof o.text === 'string' ? o.text : null,
      isCorrect: typeof o.isCorrect === 'boolean' ? o.isCorrect : null,
    }))
    .filter((o): o is ScorableOption => !!o.label && !!o.text && typeof o.isCorrect === 'boolean');
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function areJsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function coerceCorrectVariants(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/**
 * Pick the answer text most suitable for a cloze blank from the correct
 * option text plus any correctVariants. Prefers the shortest variant that
 * trims to 1-2 words; falls back to the original correct text.
 *
 * This lets bank Questions whose primary correct option is a long phrase
 * still generate a useful QR cloze card, by adding a short paraphrase to
 * correctVariants (e.g. "Combined oral contraceptive pill" → variant "COCP").
 */
function chooseClozeAnswer(
  correctText: string,
  correctVariants: string[],
): { text: string; fromVariant: boolean } | null {
  // Score the correct option text first, then each variant. Skip variants
  // that are textual duplicates of correctText — they're noise, not new
  // information.
  //
  // A "lossy" trim (multi-comma list collapsed to first item) is allowed
  // only when the curator explicitly opted in via a *short-form* variant.
  // Otherwise we'd silently drop concepts (e.g. "Fever, pharyngitis,
  // lymphadenopathy" → "Fever").
  const correctNormalized = correctText.trim().toLowerCase();
  const candidates: Array<{ text: string; fromVariant: boolean }> = [
    { text: correctText, fromVariant: false },
    ...correctVariants
      .filter((v) => v.trim().toLowerCase() !== correctNormalized)
      .map((v) => ({ text: v, fromVariant: true })),
  ];
  let best: { text: string; fromVariant: boolean } | null = null;
  let bestWords = Infinity;
  for (const c of candidates) {
    const trimmed = trimAnswerForCloze(c.text);
    if (!trimmed) continue;
    const words = trimmed.split(/\s+/).length;
    if (words > 2 || words >= bestWords) continue;
    // Reject lossy-trim picks: when the raw text has ≥2 commas, trimming to
    // the first item drops information the author may not have intended to
    // discard. Curated variants are presumed clean (and dedup above ensures
    // they really are different from correctText), but lossy trim is still
    // a smell — check that the trimmed form is materially shorter than the
    // raw text by character count.
    const rawCharCount = c.text.length;
    const trimmedCharCount = trimmed.length;
    const isLossyTrim = (c.text.match(/,/g) ?? []).length >= 2 && trimmedCharCount < rawCharCount * 0.5;
    if (isLossyTrim) continue;
    best = c;
    bestWords = words;
    if (words === 1) break;
  }
  return best;
}

export function buildPrimaryCardDraft(
  question: {
    id: string;
    stem: string;
    options: unknown;
    correctVariants?: unknown;
    context: string | null;
    topics: string[];
    rotation: string;
    week: number | null;
    difficulty: string;
    crosslinks: Prisma.JsonValue | null;
    imageUrl: string | null;
    imageCaption: string | null;
  },
  stableId: string
): PrimaryCardDraft | null {
  const scorableOptions = coerceScorableOptions(question.options);
  const correctOption = scorableOptions.find((o) => o.isCorrect);
  if (!correctOption) return null;

  // "All of the above" / "None of the above" answers don't survive as a
  // standalone flashcard back — the original options aren't shown. Skip QR
  // card creation; the bank MCQ still covers the content.
  if (shouldOmitMcqCard(question.stem, correctOption.text)) return null;

  const topics = Array.isArray(question.topics) && question.topics.length > 0
    ? question.topics
    : ['mcq'];

  const variants = coerceCorrectVariants(question.correctVariants);
  const chosen = chooseClozeAnswer(correctOption.text, variants);
  if (!chosen) return null;
  const { text: clozeAnswerText, fromVariant } = chosen;

  if (shouldSkipClozeConversion(question.stem, clozeAnswerText)) return null;
  const crosslinks = (question.crosslinks ?? undefined) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined;

  // QuestionReinforcement rows are flashcards, not option-rendering MCQs.
  // If the stem cannot become a proper cloze, keep the parent bank question as
  // the only teachable unit instead of preserving a raw front/back card.
  const cloze = mcqToCloze(question.stem, clozeAnswerText);
  if (!cloze || !cloze.includes('[___]')) return null;
  if (stemRequiresOptions(question.stem)) return null;

  return {
    cardType: 'cloze',
    rotation: question.rotation,
    week: question.week ?? 1,
    sourceComponent: 'QuestionReinforcement',
    stableId,
    front: cloze,
    // Use the trimmed cloze answer — keeps the back to a 1-2 word concept
    // instead of the full option text. The full option text remains visible
    // on the parent MCQ.
    back: trimAnswerForCloze(clozeAnswerText) ?? clozeAnswerText,
    context: normalizeContextForCard(question.context ?? null),
    topics,
    difficulty: question.difficulty ?? 'medium',
    crosslinks,
    imageUrl: question.imageUrl ?? null,
    imageCaption: question.imageCaption ?? null,
    curated: fromVariant,
  };
}

export function computePrimaryCardUpdate(
  existing: ExistingPrimaryCard,
  desired: PrimaryCardDraft
): Record<string, unknown> {
  const updateData: Record<string, unknown> = {};

  if (existing.stableId !== desired.stableId) updateData.stableId = desired.stableId;
  if (existing.cardType !== desired.cardType) updateData.cardType = desired.cardType;
  if (existing.rotation !== desired.rotation) updateData.rotation = desired.rotation;
  if (existing.week !== desired.week) updateData.week = desired.week;
  if (existing.sourceComponent !== desired.sourceComponent) updateData.sourceComponent = desired.sourceComponent;
  if (existing.front !== desired.front) updateData.front = desired.front;
  if (existing.back !== desired.back) updateData.back = desired.back;
  if ((existing.context ?? null) !== (desired.context ?? null)) updateData.context = desired.context;
  if (!areStringArraysEqual(existing.topics ?? [], desired.topics)) updateData.topics = desired.topics;
  if (existing.difficulty !== desired.difficulty) updateData.difficulty = desired.difficulty;
  if (!areJsonEqual(existing.crosslinks, desired.crosslinks)) {
    // `crosslinks Json?` is nullable. When the source question loses its
    // crosslinks, desired.crosslinks is `undefined` — and Prisma treats an
    // `undefined` update value as "leave unchanged", so a stale crosslink can
    // never be cleared (the qcard keeps a dead deep-dive link forever). Write
    // Prisma.DbNull to actually NULL the column when clearing.
    updateData.crosslinks = desired.crosslinks ?? Prisma.DbNull;
  }
  if ((existing.imageUrl ?? null) !== (desired.imageUrl ?? null)) updateData.imageUrl = desired.imageUrl;
  if ((existing.imageCaption ?? null) !== (desired.imageCaption ?? null)) updateData.imageCaption = desired.imageCaption;

  return updateData;
}

async function findAdjacentCards(
  questionId: string,
  excludeIds: string[],
  rotation: string | null
): Promise<string[]> {
  try {
    const similar = await findCardsForQuestion(questionId, 3, 0.45);
    const ordered = similar
      .filter((c) => c.cardId && !excludeIds.includes(c.cardId))
      .sort((a, b) => {
        const aCx = a.complexity ?? 2;
        const bCx = b.complexity ?? 2;
        if (aCx !== bCx) return aCx - bCx;
        return b.similarity - a.similarity;
      })
      .map((c) => c.cardId);

    if (rotation) {
      const metas = await prisma.card.findMany({
        where: { id: { in: ordered }, rotation },
        select: { id: true },
      });
      const allowed = new Set(metas.map((m) => m.id));
      return ordered.filter((id) => allowed.has(id)).slice(0, 1);
    }

    return ordered.slice(0, 1);
  } catch (error) {
    logger.warn('Failed to find adjacent reinforcement cards', { questionId, error: String(error) });
    return [];
  }
}

export async function upsertReinforcementEmbedding(
  cardId: string,
  questionId: string,
  embed: boolean
): Promise<void> {
  if (!embed) return;
  if (!process.env.GEMINI_API_KEY) return;

  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: {
      id: true,
      front: true,
      back: true,
      context: true,
      topics: true,
      rotation: true,
      week: true,
      difficulty: true,
      complexity: true,
      importance: true,
      sourceComponent: true,
    },
  });

  if (!card) return;

  const content = formatCardForEmbedding({
    front: card.front,
    back: card.back,
    context: card.context,
    topics: card.topics,
  });

  const embedding = await embedContent(content);
  if (!embedding || embedding.length === 0) return;

  await prisma.$executeRaw`
    INSERT INTO card_embeddings (id, card_id, embedding)
    VALUES (gen_random_uuid()::text, ${card.id}, ${JSON.stringify(embedding)}::halfvec)
    ON CONFLICT (card_id) DO UPDATE SET embedding = EXCLUDED.embedding
  `;
}

async function ensureFactReinforcementCards(
  question: {
    id: string;
    stem: string;
    context: string | null;
    topics: string[];
    rotation: string;
    week: number | null;
    difficulty: string;
    crosslinks: unknown;
  },
  options: Required<ReinforcementOptions>
): Promise<string[]> {
  const maxExtraCards = options.maxExtraCards;
  if (maxExtraCards <= 0) return [];

  // MCQ-style stems ("which of the following", etc.) make nonsensical cloze
  // prompts like "Which of the following...? Key fact: ______". Skip entirely.
  if (shouldSkipClozeConversion(question.stem, '')) return [];

  const factLinks = await prisma.questionFact.findMany({
    where: { questionId: question.id, isRequired: true },
    include: {
      fact: {
        select: {
          id: true,
          statement: true,
          topics: true,
          rotation: true,
          week: true,
          examWeight: true,
        },
      },
    },
  });

  const factCandidates = factLinks
    .map((link) => link.fact)
    .filter((fact): fact is NonNullable<typeof fact> => !!fact)
    .filter((fact) => {
      const statement = fact.statement?.trim();
      return !!statement && statement.length >= 12 && statement.length <= 220;
    })
    .sort((a, b) => (b.examWeight ?? 1) - (a.examWeight ?? 1))
    .slice(0, maxExtraCards);

  if (factCandidates.length === 0) return [];

  const stableIds = factCandidates.map((fact) => `${REINFORCEMENT_STABLE_ID_PREFIX}${question.id}:fact:${fact.id}`);
  const existing = await prisma.card.findMany({
    where: { stableId: { in: stableIds } },
    select: { id: true, stableId: true },
  });
  const existingByStableId = new Map(existing.map((card) => [card.stableId ?? '', card.id]));

  // No new fact-card rows are minted (same policy as the primary QR card).
  // We only surface fact cards that already exist in the DB.
  const extraCardIds: string[] = [];
  for (const fact of factCandidates) {
    const stableId = `${REINFORCEMENT_STABLE_ID_PREFIX}${question.id}:fact:${fact.id}`;
    const existingId = existingByStableId.get(stableId);
    if (existingId) extraCardIds.push(existingId);
  }
  return extraCardIds;
}

export async function ensureReinforcementCardsForQuestion(
  questionId: string,
  options: ReinforcementOptions = {}
): Promise<{
  cardId: string;
  rotation: string;
  week: number;
  created: boolean;
  extraCardIds: string[];
  adjacentCardIds: string[];
} | null> {
  const normalizedOptions: Required<ReinforcementOptions> = {
    maxExtraCards: options.maxExtraCards ?? REINFORCEMENT_MAX_EXTRA_CARDS,
    embed: options.embed ?? true,
  };

  const question = await prisma.question.findUnique({
    where: { id: questionId },
    select: {
      id: true,
      stem: true,
      options: true,
      correctVariants: true,
      context: true,
      topics: true,
      rotation: true,
      moduleNodes: true,
      week: true,
      difficulty: true,
      crosslinks: true,
      imageUrl: true,
      imageCaption: true,
      cardId: true,
    },
  });

  if (!question || !question.rotation) return null;

  const stableId = `${REINFORCEMENT_STABLE_ID_PREFIX}${questionId}`;

  // Helper: when the parent question is no longer eligible for QR cards,
  // soft-delete the linked primary card and every deterministic fact sibling.
  // The prefix match matters for legacy `qcard:<questionId>:fact:*` rows, which
  // do not have a direct Question.card relation.
  const retireIfPresent = async () => {
    try {
      // Some tests mock prisma without updateMany — tolerate the absence.
      if (typeof prisma.card.updateMany !== 'function') return;
      await prisma.card.updateMany({
        where: {
          OR: [
            { stableId },
            { stableId: { startsWith: `${stableId}:fact:` } },
            ...(question.cardId
              ? [{ id: question.cardId, sourceComponent: 'QuestionReinforcement' }]
              : []),
          ],
        },
        data: { deletedAt: new Date() },
      });
    } catch (err) {
      logger.warn('retireIfPresent failed', { questionId, error: String(err) });
    }
  };

  // Public Step 1 raw questions have one answer-bearing delivery contract:
  // opaque pre-grade session items followed by a committed post-grade reveal.
  // A derived flashcard copies the correct option into Card.back and therefore
  // cannot be created, updated, resurrected, embedded, or queued here.
  if (isRawPublicUsmleQuestionIdentity(question)) {
    await retireIfPresent();
    return null;
  }

  const desiredPrimaryCard = buildPrimaryCardDraft(
    {
      id: question.id,
      stem: question.stem,
      options: question.options,
      correctVariants: question.correctVariants,
      context: normalizeContextForCard(question.context ?? null),
      topics: question.topics ?? [],
      rotation: question.rotation,
      week: question.week,
      difficulty: question.difficulty ?? 'medium',
      crosslinks: question.crosslinks ?? null,
      imageUrl: question.imageUrl ?? null,
      imageCaption: question.imageCaption ?? null,
    },
    stableId
  );
  if (!desiredPrimaryCard) {
    await retireIfPresent();
    return null;
  }

  const cardSelect = {
    id: true,
    stableId: true,
    cardType: true,
    rotation: true,
    week: true,
    sourceComponent: true,
    front: true,
    back: true,
    context: true,
    topics: true,
    difficulty: true,
    crosslinks: true,
    imageUrl: true,
    imageCaption: true,
  } as const;

  const existingStableCard = await prisma.card.findUnique({
    where: { stableId },
    select: cardSelect,
  });

  let primaryCard: ExistingPrimaryCard | null = existingStableCard as ExistingPrimaryCard | null;
  if (!primaryCard && question.cardId) {
    primaryCard = await prisma.card.findUnique({
      where: { id: question.cardId },
      select: cardSelect,
    }) as ExistingPrimaryCard | null;
  }

  let primaryCardId: string | null = null;
  let created = false;
  let updated = false;

  if (primaryCard) {
    const updateData = computePrimaryCardUpdate(primaryCard, desiredPrimaryCard);
    if (Object.keys(updateData).length > 0) {
      await prisma.card.update({
        where: { id: primaryCard.id },
        data: updateData,
      });
      updated = true;
    }
    primaryCardId = primaryCard.id;
  } else if (desiredPrimaryCard.curated) {
    // Curator-vetted cloze: the back came from a hand-authored
    // `correctVariants` entry, so we can safely mint a new QR card row.
    // Pure procedural conversion is still gated by the existing-card check
    // above (no `else` for non-curated drafts).
    //
    // First check for a soft-deleted card with the same stableId — Prisma's
    // global deletedAt filter hides them from findUnique above, but the
    // unique index on stableId still blocks plain create(). Resurrect rather
    // than reject so CardProgress history is preserved.
    const softDeleted = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "Card" WHERE "stableId" = $1 AND "deletedAt" IS NOT NULL LIMIT 1`,
      desiredPrimaryCard.stableId,
    );
    if (softDeleted.length > 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Card" SET "deletedAt" = NULL, "front" = $1, "back" = $2, "context" = $3, "topics" = $4, "difficulty" = $5, "imageUrl" = $6, "imageCaption" = $7, "rotation" = $8, "week" = $9 WHERE id = $10`,
        desiredPrimaryCard.front,
        desiredPrimaryCard.back,
        desiredPrimaryCard.context,
        desiredPrimaryCard.topics,
        desiredPrimaryCard.difficulty,
        desiredPrimaryCard.imageUrl,
        desiredPrimaryCard.imageCaption,
        desiredPrimaryCard.rotation,
        desiredPrimaryCard.week,
        softDeleted[0].id,
      );
      primaryCardId = softDeleted[0].id;
      updated = true;
    } else {
      const newCard = await prisma.card.create({
        data: {
          cardType: desiredPrimaryCard.cardType,
          rotation: desiredPrimaryCard.rotation,
          week: desiredPrimaryCard.week,
          sourceComponent: desiredPrimaryCard.sourceComponent,
          sourceFile: question.cardId ? null : `question-bank/${desiredPrimaryCard.rotation}.json`,
          stableId: desiredPrimaryCard.stableId,
          front: desiredPrimaryCard.front,
          back: desiredPrimaryCard.back,
          context: desiredPrimaryCard.context,
          topics: desiredPrimaryCard.topics,
          difficulty: desiredPrimaryCard.difficulty,
          crosslinks: desiredPrimaryCard.crosslinks,
          imageUrl: desiredPrimaryCard.imageUrl,
          imageCaption: desiredPrimaryCard.imageCaption,
        },
        select: { id: true },
      });
      primaryCardId = newCard.id;
      created = true;
    }
  }
  // Otherwise (no existing card and not curated): we don't mint new QR card
  // rows. Procedural MCQ→cloze generation can produce structurally bad cards
  // (correctness depends on the alternatives, granularity is set by option
  // text, teaching is stripped from per-option explanations). Callers should
  // schedule the parent Question for re-review instead.
  if (!primaryCardId) return null;

  if (primaryCardId && question.cardId !== primaryCardId) {
    try {
      await prisma.question.update({
        where: { id: questionId },
        data: { cardId: primaryCardId },
      });
    } catch {
      // cardId column may not exist yet (pending migration)
    }
  }

  if (primaryCardId && (created || updated)) {
    // Best-effort embeddings in the background
    void upsertReinforcementEmbedding(primaryCardId, questionId, normalizedOptions.embed).catch((error) => {
      logger.warn('Failed to embed reinforcement card', { questionId, error: String(error) });
    });
  }

  const extraCardIds = await ensureFactReinforcementCards(
    {
      id: question.id,
      stem: question.stem,
      context: normalizeContextForCard(question.context ?? null),
      topics: question.topics ?? [],
      rotation: question.rotation,
      week: question.week,
      difficulty: question.difficulty ?? 'medium',
      crosslinks: question.crosslinks ?? undefined,
    },
    normalizedOptions
  );

  const adjacentCardIds = await findAdjacentCards(
    questionId,
    [primaryCardId, ...extraCardIds],
    question.rotation
  );

  return {
    cardId: primaryCardId,
    rotation: question.rotation,
    week: question.week ?? 1,
    created,
    extraCardIds,
    adjacentCardIds,
  };
}

export async function ensureReinforcementCardForQuestion(questionId: string): Promise<{
  cardId: string;
  rotation: string;
  week: number;
  created: boolean;
  adjacentCardIds: string[];
} | null> {
  const result = await ensureReinforcementCardsForQuestion(questionId, {
    maxExtraCards: 0,
  });
  if (!result) return null;
  return {
    cardId: result.cardId,
    rotation: result.rotation,
    week: result.week,
    created: result.created,
    adjacentCardIds: result.adjacentCardIds,
  };
}

export async function queueReinforcementCard(
  userId: string,
  rotation: string,
  cardIds: string[]
): Promise<void> {
  const unique = Array.from(new Set(cardIds)).slice(0, REINFORCEMENT_MAX_ITEMS);
  if (unique.length === 0) return;

  const now = new Date();

  await prisma.cardProgress.createMany({
    data: unique.map((cardId) => ({ userId, cardId, nextDueAt: now })),
    skipDuplicates: true,
  });

  await prependCardsToQueue(userId, rotation, unique, {
    reason: 'reinforcement',
    insertOffset: REINFORCEMENT_INSERT_OFFSET,
    maxItems: REINFORCEMENT_MAX_ITEMS,
  });
}
