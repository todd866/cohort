/**
 * Build-time script: generates pre-built starter sessions for new users.
 *
 * New users with zero history get these sessions instantly (no scheduler,
 * no DB queries for content). From session 2 onward, the normal scheduler
 * path kicks in.
 *
 * Usage: npx tsx scripts/generate-starter-sessions.ts
 * Runs automatically before `next dev` and `next build`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withDefaultQuestionServingPolicy } from '../../src/lib/questions/source-policy';
import { withoutRawPublicUsmleQuestions } from '../../src/lib/usmle/raw-question-boundary';
import { withoutRawPublicUsmleReinforcementCards } from '../../src/lib/usmle/raw-reinforcement-card-boundary';
import { filterDeliverableReinforcementCardRows } from '../../src/lib/usmle/reinforcement-card-delivery';
import {
  assertGeneratedContentIsUsable,
  resolveGeneratedContentMode,
} from './generate-content-map';

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, 'src', 'lib', 'generated');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'starter-sessions.ts');

/** Minimal item shape matching what the route handler returns */
export interface StarterItem {
  type: 'card' | 'question';
  id: string;
  // Card fields
  front?: string;
  back?: string;
  backs?: string[] | null;
  context?: string | null;
  sourceComponent?: string;
  crosslinks?: unknown;
  // Question fields
  stem?: string;
  options?: Array<{ label: string; text: string; isCorrect?: boolean; explanation?: string }>;
  explanation?: string | null;
  imageUrl?: string | null;
  imageCaption?: string | null;
  imageRole?: string | null;
  // Shared
  rotation: string;
  week: number | null;
  topics?: string[];
  difficulty?: string;
  complexity?: number;
  priority?: number;
  conceptName?: string;
  // Cloze variant fields — used by suppressSiblingsInStarterCards.
  variantGroupId?: string | null;
  variantIndex?: number | null;
  variantType?: string | null;
}

/**
 * Sibling suppression: drop duplicates with the same variantGroupId, preserving
 * the first occurrence in the input order. Mirrors the live scheduler so the
 * pre-built starter sessions don't ship 2-3 near-identical cloze cards.
 *
 * Items with no variantGroupId pass through unchanged.
 */
export function suppressSiblingsInStarterCards(cards: StarterItem[]): StarterItem[] {
  const seen = new Set<string>();
  const result: StarterItem[] = [];
  for (const card of cards) {
    if (card.variantGroupId != null) {
      if (seen.has(card.variantGroupId)) continue;
      seen.add(card.variantGroupId);
    }
    result.push(card);
  }
  return result;
}

interface StarterSession {
  items: StarterItem[];
  stats: {
    totalItems: number;
    cards: number;
    questions: number;
    generatedAt: string;
  };
}

const EXCLUDED_TOPICS = ['_needs-image', '_incomplete-data'];

function isUsableQuestion(q: {
  options: unknown;
  explanation: string | null;
  topics: string[];
}): boolean {
  if (!q.explanation || q.explanation.trim().length === 0) return false;
  if (q.topics.some((t) => EXCLUDED_TOPICS.includes(t))) return false;
  if (!Array.isArray(q.options) || q.options.length < 4) return false;
  const opts = q.options as Array<{ label?: string; text?: string; isCorrect?: boolean }>;
  const valid = opts.filter((o) => o.label && o.text && typeof o.isCorrect === 'boolean');
  if (valid.length < 4) return false;
  return valid.filter((o) => o.isCorrect).length === 1;
}

/** Simple shuffle (Fisher-Yates) */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Interleave cards and questions: C Q C Q C Q ... */
function interleave(cards: StarterItem[], questions: StarterItem[]): StarterItem[] {
  const result: StarterItem[] = [];
  const maxLen = Math.max(cards.length, questions.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < cards.length) result.push(cards[i]);
    if (i < questions.length) result.push(questions[i]);
  }
  return result;
}

async function main() {
  // CONTENT_MAP_* flags historically applied only to the map generator. The
  // explicit offline/release mode is shared, while an unset direct starter
  // invocation retains its permissive legacy behavior.
  const mode = resolveGeneratedContentMode(process.env, { legacyContentMapFlags: false });
  const generatedAt = mode.generatedAt ?? new Date().toISOString();
  const sessions: Record<string, StarterSession> = {};

  if (mode.readDatabase) {
    try {
      const { prisma } = await import('../lib/db');
      try {
        // Get all rotations that have concepts
        const rotations = await prisma.concept.groupBy({
          by: ['rotation'],
          _count: { id: true },
        });

        for (const { rotation } of rotations) {
          // Load top concepts by exam weight
          const concepts = await prisma.concept.findMany({
            where: { rotation },
            orderBy: [{ examWeight: 'desc' }, { frequency: 'asc' }],
            take: 15,
            select: {
              id: true,
              name: true,
              topics: true,
              examWeight: true,
              week: true,
            },
          });

          if (concepts.length === 0) continue;

          // Pick top 10 concepts with topic diversity
          const selectedConcepts = concepts.slice(0, 10);
          const usedTopics = new Set<string>();
          const diverseConcepts = [];
          for (const c of selectedConcepts) {
            const primaryTopic = c.topics[0];
            if (primaryTopic && usedTopics.has(primaryTopic) && diverseConcepts.length >= 5) continue;
            diverseConcepts.push(c);
            for (const t of c.topics) usedTopics.add(t);
          }

          const starterCards: StarterItem[] = [];
          const starterQuestions: StarterItem[] = [];
          const usedCardIds = new Set<string>();
          const usedQuestionIds = new Set<string>();

          for (const concept of diverseConcepts) {
            const topicFilter = concept.topics.length > 0
              ? { topics: { hasSome: concept.topics } }
              : {};

            // Pick 1 card for this concept
            const card = await prisma.card.findFirst({
              where: withoutRawPublicUsmleReinforcementCards({
                rotation,
                deletedAt: null,
                id: { notIn: [...usedCardIds] },
                NOT: { topics: { hasSome: EXCLUDED_TOPICS } },
                ...topicFilter,
              }),
              orderBy: [{ complexity: 'asc' }],
              select: {
                id: true,
                front: true,
                back: true,
                backs: true,
                context: true,
                imageUrl: true,
                imageCaption: true,
                imageRole: true,
                sourceComponent: true,
                rotation: true,
                week: true,
                complexity: true,
                crosslinks: true,
                topics: true,
                difficulty: true,
                // Cloze variant fields — required for sibling suppression below.
                variantGroupId: true,
                variantIndex: true,
                variantType: true,
              },
            });

            const [deliverableCard] = card
              ? await filterDeliverableReinforcementCardRows([card], {
                  client: prisma,
                  logContext: { transport: 'generated-starter-session', rotation },
                })
              : [];

            if (deliverableCard) {
              usedCardIds.add(deliverableCard.id);
              starterCards.push({
                type: 'card',
                id: deliverableCard.id,
                front: deliverableCard.front,
                back: deliverableCard.back,
                backs: (deliverableCard.backs as string[] | null) ?? null,
                context: deliverableCard.context ?? null,
                sourceComponent: deliverableCard.sourceComponent,
                crosslinks: deliverableCard.crosslinks ?? null,
                imageUrl: deliverableCard.imageUrl ?? null,
                imageCaption: deliverableCard.imageCaption ?? null,
                imageRole: deliverableCard.imageRole ?? null,
                rotation: deliverableCard.rotation,
                week: deliverableCard.week ?? null,
                complexity: deliverableCard.complexity,
                topics: deliverableCard.topics,
                difficulty: deliverableCard.difficulty,
                priority: 1,
                conceptName: concept.name,
                variantGroupId: deliverableCard.variantGroupId ?? null,
                variantIndex: deliverableCard.variantIndex ?? null,
                variantType: deliverableCard.variantType ?? null,
              });
            }

            // Pick 1 question for this concept (medium difficulty preferred)
            const questions = await prisma.question.findMany({
              where: withoutRawPublicUsmleQuestions(
                withDefaultQuestionServingPolicy({
                  rotation,
                  id: { notIn: [...usedQuestionIds] },
                  NOT: { topics: { hasSome: EXCLUDED_TOPICS } },
                  context: { not: null },
                  ...topicFilter,
                }),
              ),
              orderBy: [{ difficulty: 'asc' }],
              take: 5,
              select: {
                id: true,
                stem: true,
                options: true,
                context: true,
                imageUrl: true,
                imageCaption: true,
                rotation: true,
                week: true,
                topics: true,
                difficulty: true,
              },
            });

            // Find a medium-difficulty usable question
            const usable = questions.filter((q) =>
              isUsableQuestion({ options: q.options, explanation: q.context, topics: q.topics })
            );
            const medium = usable.find((q) => q.difficulty === 'medium') ?? usable[0];

            if (medium) {
              usedQuestionIds.add(medium.id);
              starterQuestions.push({
                type: 'question',
                id: medium.id,
                stem: medium.stem,
                options: medium.options as StarterItem['options'],
                explanation: medium.context ?? null,
                imageUrl: medium.imageUrl ?? null,
                imageCaption: medium.imageCaption ?? null,
                // Question has no imageRole column (only Card's image-as-prompt gate
                // does) — emit null explicitly so the shared StarterItem shape is
                // consistent across card and question items.
                imageRole: null,
                rotation: medium.rotation,
                week: medium.week ?? null,
                topics: medium.topics,
                difficulty: medium.difficulty,
                priority: 1,
                conceptName: concept.name,
              });
            }
          }

          // Shuffle within type, then drop sibling cloze cards (suppression must
          // come AFTER shuffle so a different sibling can win across regenerations
          // — pre-shuffle suppression would always pick the same content-map order).
          // Then interleave.
          const suppressedStarterCards = suppressSiblingsInStarterCards(shuffle(starterCards));
          const items = interleave(suppressedStarterCards, shuffle(starterQuestions));

          if (items.length > 0) {
            sessions[rotation] = {
              items,
              stats: {
                totalItems: items.length,
                cards: suppressedStarterCards.length,
                questions: starterQuestions.length,
                generatedAt,
              },
            };
          }
        }
      } finally {
        await prisma.$disconnect();
      }
    } catch (err) {
      const errorMessage =
        `[generate-starter-sessions] Could not connect to database. Error: ${(err as Error).message}`;
      if (mode.failOnDatabaseError) {
        throw new Error(
          `${errorMessage}\n[generate-starter-sessions] ${mode.name} mode is fail-closed; aborting.`,
        );
      }
      console.warn(`${errorMessage}\n[generate-starter-sessions] Writing empty starter sessions.`);
    }
  } else {
    console.log(
      '[generate-starter-sessions] Offline mode: writing deterministic compile-only artifacts.',
    );
  }

  const totalItems = Object.values(sessions).reduce((sum, s) => sum + s.stats.totalItems, 0);
  assertGeneratedContentIsUsable(mode, 'starter sessions', totalItems);

  // Generate output file
  const lines: string[] = [];
  lines.push('/*');
  lines.push(' * AUTO-GENERATED FILE — DO NOT EDIT');
  lines.push(' *');
  lines.push(' * Generated by: scripts/generate-starter-sessions.ts');
  lines.push(` * Generated at: ${generatedAt}`);
  lines.push(` * Build mode: ${mode.name}`);
  lines.push(` * Rotations: ${Object.keys(sessions).join(', ') || '(none)'}`);
  lines.push(' */');
  lines.push('');

  lines.push('export interface StarterItem {');
  lines.push("  type: 'card' | 'question';");
  lines.push('  id: string;');
  lines.push('  front?: string;');
  lines.push('  back?: string;');
  lines.push('  backs?: string[] | null;');
  lines.push('  context?: string | null;');
  lines.push('  sourceComponent?: string;');
  lines.push('  crosslinks?: unknown;');
  lines.push('  stem?: string;');
  lines.push('  options?: Array<{ label: string; text: string; isCorrect?: boolean; explanation?: string }>;');
  lines.push('  explanation?: string | null;');
  lines.push('  imageUrl?: string | null;');
  lines.push('  imageCaption?: string | null;');
  lines.push('  imageRole?: string | null;');
  lines.push('  rotation: string;');
  lines.push('  week: number | null;');
  lines.push('  topics?: string[];');
  lines.push('  difficulty?: string;');
  lines.push('  complexity?: number;');
  lines.push('  priority?: number;');
  lines.push('  conceptName?: string;');
  lines.push('  variantGroupId?: string | null;');
  lines.push('  variantIndex?: number | null;');
  lines.push('  variantType?: string | null;');
  lines.push('}');
  lines.push('');

  lines.push('export interface StarterSession {');
  lines.push('  items: StarterItem[];');
  lines.push('  stats: {');
  lines.push('    totalItems: number;');
  lines.push('    cards: number;');
  lines.push('    questions: number;');
  lines.push('    generatedAt: string;');
  lines.push('  };');
  lines.push('}');
  lines.push('');

  lines.push('export const STARTER_SESSIONS: Record<string, StarterSession> = ');
  lines.push(JSON.stringify(sessions, null, 2) + ';');
  lines.push('');

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(OUTPUT_FILE, lines.join('\n'), 'utf8');

  console.log(
    `[generate-starter-sessions] Wrote ${Object.keys(sessions).length} rotation(s), ${totalItems} items → ${path.relative(ROOT, OUTPUT_FILE)}`
  );
}

// Tests import the pure sibling-suppression helper from this module. Running
// the generator on import races other workers reading the generated module:
// fs.writeFile briefly truncates it, which can make STARTER_SESSIONS undefined
// in an unrelated unified-session test. Generate only for the documented
// direct CLI/build invocation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[generate-starter-sessions] Fatal error:', error);
    process.exitCode = 1;
  });
}
