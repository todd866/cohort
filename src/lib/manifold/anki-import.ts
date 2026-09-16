/**
 * Anki Import
 *
 * Import .apkg files (SQLite databases in ZIP format)
 * Handles 250k+ cards with batch processing
 */

import * as fs from 'fs';
import * as path from 'path';
import * as unzipper from 'unzipper';
import Database from 'better-sqlite3';
import { prisma } from '@/lib/prisma';
import { embedBatch, formatCardForEmbedding } from './embeddings';
import { assignMissingCardClusters } from './cluster-assignment';

export interface AnkiImportResult {
  totalCards: number;
  imported: number;
  skipped: number;
  errors: number;
  duration: number;
}

interface AnkiCard {
  id: number;
  nid: number; // Note ID
  did: number; // Deck ID
  ord: number; // Card ordinal (which card template)
  mod: number; // Modification time
  type: number; // 0=new, 1=learning, 2=review
  queue: number; // Queue status
  due: number;
  ivl: number; // Interval
  factor: number; // Ease factor
  reps: number; // Number of reviews
  lapses: number; // Number of lapses
}

interface AnkiNote {
  id: number;
  mid: number; // Model ID
  mod: number;
  flds: string; // Fields separated by \x1f
  tags: string;
}

interface AnkiDeck {
  id: number;
  name: string;
}

/**
 * Import an Anki .apkg file
 */
export async function importAnkiDeck(
  apkgPath: string,
  rotation: string,
  options: {
    batchSize?: number;
    generateEmbeddings?: boolean;
    onProgress?: (stage: string, current: number, total: number) => void;
  } = {}
): Promise<AnkiImportResult> {
  const startTime = Date.now();
  const { batchSize = 500, generateEmbeddings = false, onProgress } = options;

  const result: AnkiImportResult = {
    totalCards: 0,
    imported: 0,
    skipped: 0,
    errors: 0,
    duration: 0,
  };

  // Extract .apkg (it's a ZIP file)
  const tempDir = path.join('/tmp', `anki-import-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    onProgress?.('Extracting archive', 0, 1);

    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(apkgPath)
        .pipe(unzipper.Extract({ path: tempDir }))
        .on('close', resolve)
        .on('error', reject);
    });

    // Open the SQLite database
    const dbPath = path.join(tempDir, 'collection.anki2');
    if (!fs.existsSync(dbPath)) {
      throw new Error('Invalid .apkg file: collection.anki2 not found');
    }

    const db = new Database(dbPath, { readonly: true });

    // Get deck info
    const col = db.prepare('SELECT decks FROM col').get() as { decks: string };
    const decks: Record<string, AnkiDeck> = JSON.parse(col.decks);

    // Get all notes
    const notes = db.prepare('SELECT * FROM notes').all() as AnkiNote[];
    const noteMap = new Map(notes.map((n) => [n.id, n]));

    // Get all cards
    const cards = db.prepare('SELECT * FROM cards').all() as AnkiCard[];
    result.totalCards = cards.length;

    onProgress?.('Processing cards', 0, cards.length);

    // Process in batches
    const cardsToEmbed: Array<{ id: string; content: string }> = [];

    for (let i = 0; i < cards.length; i += batchSize) {
      const batch = cards.slice(i, i + batchSize);
      const prismaCards: Array<{
        id: string;
        cardType: string;
        rotation: string;
        week: number;
        sourceFile: string;
        sourceComponent: string;
        front: string;
        back: string;
        context: string | null;
        topics: string[];
        difficulty: string;
        importance: number;
      }> = [];

      for (const card of batch) {
        try {
          const note = noteMap.get(card.nid);
          if (!note) {
            result.skipped++;
            continue;
          }

          // Parse fields (separated by \x1f)
          const fields = note.flds.split('\x1f');
          const front = stripHtml(fields[0] || '');
          const back = stripHtml(fields[1] || '');

          if (!front || !back) {
            result.skipped++;
            continue;
          }

          // Parse tags
          const tags = note.tags
            .split(' ')
            .filter((t) => t.length > 0)
            .map((t) => t.replace(/::/g, '/'));

          // Infer week from tags or deck name
          const week = inferWeek(tags, decks[card.did]?.name);

          // Infer difficulty from Anki ease factor
          const difficulty = inferDifficulty(card.factor);

          const cardId = `anki-${card.id}`;

          prismaCards.push({
            id: cardId,
            cardType: 'cloze', // Anki cards are treated as cloze
            rotation,
            week,
            sourceFile: `anki-import-${decks[card.did]?.name || 'unknown'}`,
            sourceComponent: 'Anki',
            front,
            back,
            context: fields[2] ? stripHtml(fields[2]) : null,
            topics: tags,
            difficulty,
            importance: 1,
          });

          if (generateEmbeddings) {
            cardsToEmbed.push({
              id: cardId,
              content: formatCardForEmbedding({ front, back, topics: tags }),
            });
          }

          result.imported++;
        } catch {
          result.errors++;
        }
      }

      // Bulk insert
      if (prismaCards.length > 0) {
        await prisma.card.createMany({
          data: prismaCards,
          skipDuplicates: true,
        });
      }

      onProgress?.('Processing cards', Math.min(i + batchSize, cards.length), cards.length);
    }

    // Generate embeddings if requested
    if (generateEmbeddings && cardsToEmbed.length > 0) {
      onProgress?.('Generating embeddings', 0, cardsToEmbed.length);

      const embeddings = await embedBatch(cardsToEmbed, (completed, total) => {
        onProgress?.('Generating embeddings', completed, total);
      });

      // Store embeddings
      onProgress?.('Storing embeddings', 0, embeddings.length);

      for (let i = 0; i < embeddings.length; i += batchSize) {
        const batch = embeddings.slice(i, i + batchSize);

        // Use raw SQL for pgvector insert
        for (const emb of batch) {
          if (emb.embedding.length > 0) {
            await prisma.$executeRaw`
              INSERT INTO card_embeddings (id, card_id, embedding)
              VALUES (gen_random_uuid()::text, ${emb.id}, ${JSON.stringify(emb.embedding)}::halfvec)
              ON CONFLICT (card_id) DO UPDATE SET embedding = EXCLUDED.embedding
            `;
          }
        }

        onProgress?.(
          'Storing embeddings',
          Math.min(i + batchSize, embeddings.length),
          embeddings.length
        );
      }

      // Keep the vector and cluster invariants together for imports into an
      // established rotation. A brand-new rotation deliberately remains for
      // the reviewed bootstrap command rather than inventing topology here.
      while (true) {
        const assignment = await assignMissingCardClusters({ rotation, limit: 1_000 });
        if (!assignment.ok) {
          throw new Error(
            `Post-import cluster assignment failed: ${assignment.errors.map((error) => error.message).join('; ')}`,
          );
        }
        if (assignment.skipped.noCentroid > 0 || assignment.counts.deferredByLimit === 0) break;
        if (assignment.counts.assigned === 0) {
          throw new Error('Post-import cluster assignment made no progress.');
        }
      }
    }

    db.close();
  } finally {
    // Cleanup temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  result.duration = Date.now() - startTime;
  return result;
}

/**
 * Import Anki review history for a user
 * Populates CardProgress with historical data
 */
export async function importAnkiHistory(
  apkgPath: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _rotation: string
): Promise<{ imported: number }> {
  const tempDir = path.join('/tmp', `anki-history-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(apkgPath)
        .pipe(unzipper.Extract({ path: tempDir }))
        .on('close', resolve)
        .on('error', reject);
    });

    const dbPath = path.join(tempDir, 'collection.anki2');
    const db = new Database(dbPath, { readonly: true });

    // Get review log
    const reviews = db
      .prepare(
        `
      SELECT
        cid as card_id,
        ease,
        ivl as interval_days,
        factor,
        id as reviewed_at
      FROM revlog
      ORDER BY id
    `
      )
      .all() as Array<{
      card_id: number;
      ease: number;
      interval_days: number;
      factor: number;
      reviewed_at: number;
    }>;

    // Group by card
    const cardHistories = new Map<number, typeof reviews>();
    for (const review of reviews) {
      if (!cardHistories.has(review.card_id)) {
        cardHistories.set(review.card_id, []);
      }
      const history = cardHistories.get(review.card_id);
      if (history) history.push(review);
    }

    let imported = 0;

    // Create CardProgress for each card with history
    for (const [ankiCardId, history] of cardHistories) {
      const lastReview = history[history.length - 1];

      const card = await prisma.card.findUnique({
        where: {
          id: `anki-${ankiCardId}`,
        },
      });

      if (!card) continue;

      // Calculate retrieval strength from history
      let strength = 0;
      for (const review of history) {
        const quality = Math.min(5, Math.max(0, review.ease));
        const successRate = quality >= 3 ? (quality - 2) / 3 : 0;
        strength = strength * 0.9 + successRate * 0.1;
      }

      const lastReviewedAt = new Date(lastReview.reviewed_at);
      const intervalDays = Math.max(0, lastReview.interval_days);
      const stabilityDays = Math.max(1, intervalDays || 3);
      const nextDueAt = new Date(lastReviewedAt.getTime() + intervalDays * 24 * 60 * 60 * 1000);

      await prisma.cardProgress.upsert({
        where: {
          cardId_userId: { cardId: card.id, userId },
        },
        create: {
          cardId: card.id,
          userId,
          stabilityDays,
          nextDueAt,
          lastReview: lastReviewedAt,
          lastQuality: lastReview.ease,
          totalReviews: history.length,
          retrievalStrength: strength,
        },
        update: {
          stabilityDays,
          nextDueAt,
          lastReview: lastReviewedAt,
          lastQuality: lastReview.ease,
          totalReviews: history.length,
          retrievalStrength: strength,
        },
      });

      imported++;
    }

    db.close();
    return { imported };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Helper functions

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function inferWeek(tags: string[], deckName?: string): number {
  // Look for week indicator in tags
  for (const tag of tags) {
    const match = tag.match(/week[_\-]?(\d+)/i);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  // Look in deck name
  if (deckName) {
    const match = deckName.match(/week[_\-]?(\d+)/i);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  return 1; // Default to week 1
}

function inferDifficulty(factor: number): string {
  // Anki factor is typically 2500 (2.5) for normal cards
  if (factor >= 2700) return 'easy';
  if (factor <= 2000) return 'hard';
  return 'medium';
}
