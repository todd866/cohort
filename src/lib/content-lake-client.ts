/**
 * Content Lake Client
 *
 * Server-side utility to access the SQLite content lake database.
 * Used by API routes to fetch lake citations for cards.
 */

import path from 'path';
import { ContentLakeDB, CardCitationWithDetails } from '../../scripts/content-lake/storage';

const CONTENT_LAKE_PATH =
  process.env.CONTENT_LAKE_PATH || path.join(process.cwd(), 'data/content-lake.sqlite');

// Singleton instance for reuse within server
let dbInstance: ContentLakeDB | null = null;

/**
 * Get a content lake database instance.
 * Uses a singleton pattern to avoid opening multiple connections.
 */
export function getContentLakeDB(): ContentLakeDB {
  if (!dbInstance) {
    dbInstance = new ContentLakeDB(CONTENT_LAKE_PATH);
  }
  return dbInstance;
}

/**
 * Get lake citations for a card.
 * Returns citations with full chunk and source details.
 */
export function getCardLakeCitations(cardId: string): CardCitationWithDetails[] {
  const db = getContentLakeDB();
  return db.getCardCitations(cardId);
}

/**
 * Check if content lake database exists and has data.
 */
export function isContentLakeAvailable(): boolean {
  try {
    const db = getContentLakeDB();
    const stats = db.getSourceStats();
    return stats.chunks > 0;
  } catch {
    return false;
  }
}

/**
 * Get chunks for a specific source and article title pattern.
 */
export function getChunksBySourceAndTitle(
  sourceId: string,
  titlePattern: string
): Array<{
  id: string;
  heading: string;
  content: string;
  wordCount: number;
  articleTitle: string;
}> {
  try {
    const db = getContentLakeDB();
    const rows = db.queryAll<{
      id: string;
      heading: string;
      content: string;
      word_count: number;
      article_title: string;
    }>(
      `SELECT c.id, c.heading, c.content, c.word_count, a.title as article_title
       FROM chunks c
       JOIN articles a ON c.article_id = a.id
       WHERE a.source_id = ?
       AND a.title LIKE ?
       ORDER BY a.title, c.char_offset_start
       LIMIT 500`,
      sourceId,
      `%${titlePattern}%`,
    );

    return rows.map((row) => ({
      id: row.id,
      heading: row.heading,
      content: row.content,
      wordCount: row.word_count,
      articleTitle: row.article_title,
    }));
  } catch {
    return [];
  }
}

// Export types for use in API routes
export type { CardCitationWithDetails };
