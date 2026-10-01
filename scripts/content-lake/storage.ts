/**
 * Content Lake Storage
 *
 * SQLite-based storage for the certification layer.
 * Provides local, queryable storage for sources, articles, chunks, and cross-references.
 */

import Database from 'better-sqlite3';
import type { Source, Article, Chunk, CrossRef, CardCitation, ChunkCurriculum } from './types';

// Return type for getCardCitations with full chunk and source details
export interface CardCitationWithDetails {
  cardId: string;
  chunkId: string;
  citationType: 'supports' | 'derived_from';
  heading: string;
  content: string;
  articleId: string;
  articleTitle: string;
  articleUrl: string;
  sourceName: string;
  reliabilityTier: 'gold' | 'silver' | 'bronze';
}

export class ContentLakeDB {
  private db: Database.Database;
  private embeddingsCache: Map<string, Float32Array> | null = null;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  /** Run a raw read-only SQL query with parameters. */
  queryAll<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /**
   * Load all embeddings into memory cache for fast repeated searches.
   * Call this once before doing many semantic searches.
   */
  loadEmbeddingsCache(): void {
    if (this.embeddingsCache) return; // Already loaded

    console.log('Loading embeddings into memory...');
    const rows = this.db
      .prepare('SELECT chunk_id, embedding FROM chunk_embeddings')
      .all() as Array<{ chunk_id: string; embedding: Buffer }>;

    this.embeddingsCache = new Map();
    for (const row of rows) {
      const embedding = new Float32Array(
        row.embedding.buffer.slice(
          row.embedding.byteOffset,
          row.embedding.byteOffset + row.embedding.byteLength
        )
      );
      this.embeddingsCache.set(row.chunk_id, embedding);
    }
    console.log(`Loaded ${this.embeddingsCache.size} embeddings into cache`);
  }

  /**
   * Clear the embeddings cache to free memory.
   */
  clearEmbeddingsCache(): void {
    this.embeddingsCache = null;
  }

  /**
   * Fast semantic search using cached embeddings.
   * Call loadEmbeddingsCache() first for best performance.
   */
  semanticSearchFast(
    queryEmbedding: Float32Array,
    limit: number = 10,
    threshold: number = 0.7
  ): Array<{
    chunkId: string;
    similarity: number;
    heading: string;
    content: string;
    articleId: string;
    articleTitle: string;
    articleUrl: string;
    sourceName: string;
    reliabilityTier: 'gold' | 'silver' | 'bronze';
  }> {
    // Use cache if available, otherwise load on demand
    if (!this.embeddingsCache) {
      this.loadEmbeddingsCache();
    }

    // Compute similarities against cached embeddings
    const similarities: Array<{ chunkId: string; similarity: number }> = [];

    for (const [chunkId, embedding] of this.embeddingsCache!) {
      const similarity = this.cosineSimilarity(queryEmbedding, embedding);
      if (similarity >= threshold) {
        similarities.push({ chunkId, similarity });
      }
    }

    // Sort and take top N
    similarities.sort((a, b) => b.similarity - a.similarity);
    const topMatches = similarities.slice(0, limit);

    if (topMatches.length === 0) {
      return [];
    }

    // Get full chunk details for top matches
    const results: Array<{
      chunkId: string;
      similarity: number;
      heading: string;
      content: string;
      articleId: string;
      articleTitle: string;
      articleUrl: string;
      sourceName: string;
      reliabilityTier: 'gold' | 'silver' | 'bronze';
    }> = [];

    for (const match of topMatches) {
      const row = this.db
        .prepare(
          `
          SELECT
            c.id as chunk_id,
            c.heading,
            c.content,
            c.article_id,
            a.title as article_title,
            a.url as article_url,
            s.name as source_name,
            s.reliability_tier
          FROM chunks c
          JOIN articles a ON c.article_id = a.id
          JOIN sources s ON a.source_id = s.id
          WHERE c.id = ?
          `
        )
        .get(match.chunkId) as {
        chunk_id: string;
        heading: string;
        content: string;
        article_id: string;
        article_title: string;
        article_url: string;
        source_name: string;
        reliability_tier: 'gold' | 'silver' | 'bronze';
      } | undefined;

      if (row) {
        results.push({
          chunkId: row.chunk_id,
          similarity: match.similarity,
          heading: row.heading,
          content: row.content,
          articleId: row.article_id,
          articleTitle: row.article_title,
          articleUrl: row.article_url,
          sourceName: row.source_name,
          reliabilityTier: row.reliability_tier,
        });
      }
    }

    return results;
  }

  private initSchema(): void {
    this.db.exec(`
      -- Sources (LITFL, IBCC, etc.)
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        reliability_tier TEXT NOT NULL CHECK (reliability_tier IN ('gold', 'silver', 'bronze')),
        last_crawl TEXT NOT NULL
      );

      -- Full articles
      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id),
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        markdown TEXT NOT NULL,
        published_date TEXT,
        crawled_at TEXT NOT NULL
      );

      -- Citable chunks (paragraphs, sections)
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL REFERENCES articles(id),
        heading TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        char_offset_start INTEGER NOT NULL,
        char_offset_end INTEGER NOT NULL,
        word_count INTEGER NOT NULL
      );

      -- Cross-references: same fact in multiple sources
      CREATE TABLE IF NOT EXISTS cross_refs (
        fact_hash TEXT NOT NULL,
        chunk_id TEXT NOT NULL REFERENCES chunks(id),
        confidence REAL NOT NULL,
        PRIMARY KEY (fact_hash, chunk_id)
      );

      -- Card citations
      CREATE TABLE IF NOT EXISTS card_citations (
        card_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL REFERENCES chunks(id),
        citation_type TEXT NOT NULL CHECK (citation_type IN ('supports', 'derived_from')),
        PRIMARY KEY (card_id, chunk_id)
      );

      -- Chunk embeddings (stored as JSON blob, decoded to Float32Array at runtime)
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id TEXT PRIMARY KEY REFERENCES chunks(id),
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Curriculum mapping - links chunks to program/year/block/topic
      CREATE TABLE IF NOT EXISTS chunk_curriculum (
        chunk_id TEXT NOT NULL REFERENCES chunks(id),
        program TEXT NOT NULL,
        year TEXT NOT NULL,
        block TEXT NOT NULL,
        topic TEXT NOT NULL,
        relevance REAL NOT NULL DEFAULT 0.0,
        PRIMARY KEY (chunk_id, program, year, block, topic)
      );

      -- Indices for common queries
      CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_article ON chunks(article_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
      CREATE INDEX IF NOT EXISTS idx_cross_refs_fact ON cross_refs(fact_hash);
      CREATE INDEX IF NOT EXISTS idx_cross_refs_chunk ON cross_refs(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_card_citations_card ON card_citations(card_id);
      CREATE INDEX IF NOT EXISTS idx_card_citations_chunk ON card_citations(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_chunk ON chunk_embeddings(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_chunk_curriculum_program_year ON chunk_curriculum(program, year);
      CREATE INDEX IF NOT EXISTS idx_chunk_curriculum_block ON chunk_curriculum(block);
      CREATE INDEX IF NOT EXISTS idx_chunk_curriculum_topic ON chunk_curriculum(topic);

      -- Full-text search for chunks
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        id,
        heading,
        content,
        content='chunks',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, id, heading, content)
        VALUES (NEW.rowid, NEW.id, NEW.heading, NEW.content);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, id, heading, content)
        VALUES('delete', OLD.rowid, OLD.id, OLD.heading, OLD.content);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, id, heading, content)
        VALUES('delete', OLD.rowid, OLD.id, OLD.heading, OLD.content);
        INSERT INTO chunks_fts(rowid, id, heading, content)
        VALUES (NEW.rowid, NEW.id, NEW.heading, NEW.content);
      END;
    `);
  }

  // Source operations
  upsertSource(source: Source): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO sources (id, name, base_url, reliability_tier, last_crawl)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(source.id, source.name, source.baseUrl, source.reliabilityTier, source.lastCrawl.toISOString());
  }

  getSource(id: string): Source | null {
    const row = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as
      | {
          id: string;
          name: string;
          base_url: string;
          reliability_tier: string;
          last_crawl: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      reliabilityTier: row.reliability_tier as Source['reliabilityTier'],
      lastCrawl: new Date(row.last_crawl),
    };
  }

  getSources(): Source[] {
    const rows = this.db.prepare('SELECT * FROM sources').all() as Array<{
      id: string;
      name: string;
      base_url: string;
      reliability_tier: string;
      last_crawl: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      reliabilityTier: row.reliability_tier as Source['reliabilityTier'],
      lastCrawl: new Date(row.last_crawl),
    }));
  }

  // Article operations
  upsertArticle(article: Article): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO articles (id, source_id, url, title, markdown, published_date, crawled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        article.id,
        article.sourceId,
        article.url,
        article.title,
        article.markdown,
        article.publishedDate?.toISOString() || null,
        article.crawledAt.toISOString()
      );
  }

  getArticle(id: string): Article | null {
    const row = this.db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as
      | {
          id: string;
          source_id: string;
          url: string;
          title: string;
          markdown: string;
          published_date: string | null;
          crawled_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      sourceId: row.source_id,
      url: row.url,
      title: row.title,
      markdown: row.markdown,
      publishedDate: row.published_date ? new Date(row.published_date) : undefined,
      crawledAt: new Date(row.crawled_at),
    };
  }

  getArticlesBySource(sourceId: string): Article[] {
    const rows = this.db.prepare('SELECT * FROM articles WHERE source_id = ?').all(sourceId) as Array<{
      id: string;
      source_id: string;
      url: string;
      title: string;
      markdown: string;
      published_date: string | null;
      crawled_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      url: row.url,
      title: row.title,
      markdown: row.markdown,
      publishedDate: row.published_date ? new Date(row.published_date) : undefined,
      crawledAt: new Date(row.crawled_at),
    }));
  }

  // Chunk operations
  upsertChunk(chunk: Chunk): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO chunks (id, article_id, heading, content, content_hash, char_offset_start, char_offset_end, word_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        chunk.id,
        chunk.articleId,
        chunk.heading,
        chunk.content,
        chunk.contentHash,
        chunk.charOffsetStart,
        chunk.charOffsetEnd,
        chunk.wordCount
      );
  }

  getChunk(id: string): Chunk | null {
    const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(id) as
      | {
          id: string;
          article_id: string;
          heading: string;
          content: string;
          content_hash: string;
          char_offset_start: number;
          char_offset_end: number;
          word_count: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      articleId: row.article_id,
      heading: row.heading,
      content: row.content,
      contentHash: row.content_hash,
      charOffsetStart: row.char_offset_start,
      charOffsetEnd: row.char_offset_end,
      wordCount: row.word_count,
    };
  }

  getChunksByArticle(articleId: string): Chunk[] {
    const rows = this.db
      .prepare('SELECT * FROM chunks WHERE article_id = ? ORDER BY char_offset_start')
      .all(articleId) as Array<{
      id: string;
      article_id: string;
      heading: string;
      content: string;
      content_hash: string;
      char_offset_start: number;
      char_offset_end: number;
      word_count: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      articleId: row.article_id,
      heading: row.heading,
      content: row.content,
      contentHash: row.content_hash,
      charOffsetStart: row.char_offset_start,
      charOffsetEnd: row.char_offset_end,
      wordCount: row.word_count,
    }));
  }

  bulkUpsertChunks(chunks: Chunk[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO chunks (id, article_id, heading, content, content_hash, char_offset_start, char_offset_end, word_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((chunks: Chunk[]) => {
      for (const chunk of chunks) {
        insert.run(
          chunk.id,
          chunk.articleId,
          chunk.heading,
          chunk.content,
          chunk.contentHash,
          chunk.charOffsetStart,
          chunk.charOffsetEnd,
          chunk.wordCount
        );
      }
    });

    transaction(chunks);
  }

  searchChunks(query: string, limit: number = 100): Chunk[] {
    // Escape FTS5 special characters and wrap each term in quotes
    // This prevents terms like "management" being interpreted as column names
    const escapedQuery = query
      .replace(/[":*^~(){}[\]\\]/g, ' ') // Remove FTS special chars
      .split(/\s+/)
      .filter((term) => term.length > 0)
      .map((term) => `"${term}"`) // Quote each term
      .join(' ');

    if (!escapedQuery) {
      return [];
    }

    const rows = this.db
      .prepare(
        `
      SELECT chunks.* FROM chunks_fts
      JOIN chunks ON chunks_fts.id = chunks.id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `
      )
      .all(escapedQuery, limit) as Array<{
      id: string;
      article_id: string;
      heading: string;
      content: string;
      content_hash: string;
      char_offset_start: number;
      char_offset_end: number;
      word_count: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      articleId: row.article_id,
      heading: row.heading,
      content: row.content,
      contentHash: row.content_hash,
      charOffsetStart: row.char_offset_start,
      charOffsetEnd: row.char_offset_end,
      wordCount: row.word_count,
    }));
  }

  /**
   * Get chunks matching a SQL LIKE pattern on content
   */
  getChunksByContentPattern(pattern: string, limit: number = 10000): Chunk[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM chunks
      WHERE content LIKE ?
      LIMIT ?
    `
      )
      .all(pattern, limit) as Array<{
      id: string;
      article_id: string;
      heading: string;
      content: string;
      content_hash: string;
      char_offset_start: number;
      char_offset_end: number;
      word_count: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      articleId: row.article_id,
      heading: row.heading,
      content: row.content,
      contentHash: row.content_hash,
      charOffsetStart: row.char_offset_start,
      charOffsetEnd: row.char_offset_end,
      wordCount: row.word_count,
    }));
  }

  // Cross-reference operations
  upsertCrossRef(crossRef: CrossRef): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO cross_refs (fact_hash, chunk_id, confidence)
      VALUES (?, ?, ?)
    `
      )
      .run(crossRef.factHash, crossRef.chunkId, crossRef.confidence);
  }

  getCrossRefsByFact(factHash: string): CrossRef[] {
    const rows = this.db.prepare('SELECT * FROM cross_refs WHERE fact_hash = ?').all(factHash) as Array<{
      fact_hash: string;
      chunk_id: string;
      confidence: number;
    }>;
    return rows.map((row) => ({
      factHash: row.fact_hash,
      chunkId: row.chunk_id,
      confidence: row.confidence,
    }));
  }

  getCrossRefsByChunk(chunkId: string): CrossRef[] {
    const rows = this.db.prepare('SELECT * FROM cross_refs WHERE chunk_id = ?').all(chunkId) as Array<{
      fact_hash: string;
      chunk_id: string;
      confidence: number;
    }>;
    return rows.map((row) => ({
      factHash: row.fact_hash,
      chunkId: row.chunk_id,
      confidence: row.confidence,
    }));
  }

  // Card citation operations
  upsertCardCitation(citation: CardCitation): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO card_citations (card_id, chunk_id, citation_type)
      VALUES (?, ?, ?)
    `
      )
      .run(citation.cardId, citation.chunkId, citation.citationType);
  }

  getCardCitations(cardId: string): CardCitationWithDetails[] {
    const rows = this.db
      .prepare(
        `
      SELECT
        cc.card_id,
        cc.chunk_id,
        cc.citation_type,
        c.heading,
        c.content,
        c.article_id,
        a.title as article_title,
        a.url as article_url,
        s.name as source_name,
        s.reliability_tier
      FROM card_citations cc
      JOIN chunks c ON cc.chunk_id = c.id
      JOIN articles a ON c.article_id = a.id
      JOIN sources s ON a.source_id = s.id
      WHERE cc.card_id = ?
    `
      )
      .all(cardId) as Array<{
      card_id: string;
      chunk_id: string;
      citation_type: string;
      heading: string;
      content: string;
      article_id: string;
      article_title: string;
      article_url: string;
      source_name: string;
      reliability_tier: string;
    }>;
    return rows.map((row) => ({
      cardId: row.card_id,
      chunkId: row.chunk_id,
      citationType: row.citation_type as 'supports' | 'derived_from',
      heading: row.heading,
      content: row.content,
      articleId: row.article_id,
      articleTitle: row.article_title,
      articleUrl: row.article_url,
      sourceName: row.source_name,
      reliabilityTier: row.reliability_tier as 'gold' | 'silver' | 'bronze',
    }));
  }

  bulkUpsertCardCitations(citations: CardCitation[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO card_citations (card_id, chunk_id, citation_type)
      VALUES (?, ?, ?)
    `);

    const transaction = this.db.transaction((citations: CardCitation[]) => {
      for (const citation of citations) {
        insert.run(citation.cardId, citation.chunkId, citation.citationType);
      }
    });

    transaction(citations);
  }

  deleteCardCitations(cardId: string): void {
    this.db.prepare('DELETE FROM card_citations WHERE card_id = ?').run(cardId);
  }

  getCardsWithCitations(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT card_id FROM card_citations')
      .all() as Array<{ card_id: string }>;
    return rows.map((row) => row.card_id);
  }

  // Embedding operations
  upsertChunkEmbedding(chunkId: string, embedding: Float32Array): void {
    // Store as raw binary buffer for efficiency
    const buffer = Buffer.from(embedding.buffer);
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding, created_at)
      VALUES (?, ?, datetime('now'))
    `
      )
      .run(chunkId, buffer);
  }

  getChunkEmbedding(chunkId: string): Float32Array | null {
    const row = this.db.prepare('SELECT embedding FROM chunk_embeddings WHERE chunk_id = ?').get(chunkId) as
      | { embedding: Buffer }
      | undefined;
    if (!row) return null;
    return new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength));
  }

  bulkUpsertChunkEmbeddings(embeddings: Array<{ chunkId: string; embedding: Float32Array }>): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding, created_at)
      VALUES (?, ?, datetime('now'))
    `);

    const transaction = this.db.transaction((embeddings: Array<{ chunkId: string; embedding: Float32Array }>) => {
      for (const { chunkId, embedding } of embeddings) {
        const buffer = Buffer.from(embedding.buffer);
        insert.run(chunkId, buffer);
      }
    });

    transaction(embeddings);
  }

  getChunksWithoutEmbeddings(limit: number = 1000): Chunk[] {
    const rows = this.db
      .prepare(
        `
      SELECT c.* FROM chunks c
      LEFT JOIN chunk_embeddings ce ON c.id = ce.chunk_id
      WHERE ce.chunk_id IS NULL
      LIMIT ?
    `
      )
      .all(limit) as Array<{
      id: string;
      article_id: string;
      heading: string;
      content: string;
      content_hash: string;
      char_offset_start: number;
      char_offset_end: number;
      word_count: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      articleId: row.article_id,
      heading: row.heading,
      content: row.content,
      contentHash: row.content_hash,
      charOffsetStart: row.char_offset_start,
      charOffsetEnd: row.char_offset_end,
      wordCount: row.word_count,
    }));
  }

  getEmbeddingCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM chunk_embeddings').get() as { count: number };
    return row.count;
  }

  /**
   * Semantic search: find chunks similar to a query embedding.
   * Uses cosine similarity computed in JavaScript (SQLite doesn't have vector ops).
   */
  semanticSearch(
    queryEmbedding: Float32Array,
    limit: number = 10,
    threshold: number = 0.7
  ): Array<{
    chunkId: string;
    similarity: number;
    heading: string;
    content: string;
    articleId: string;
    articleTitle: string;
    articleUrl: string;
    sourceName: string;
    reliabilityTier: 'gold' | 'silver' | 'bronze';
  }> {
    // Step 1: Load all embeddings from database
    const embeddingRows = this.db
      .prepare('SELECT chunk_id, embedding FROM chunk_embeddings')
      .all() as Array<{ chunk_id: string; embedding: Buffer }>;

    // Step 2: Compute cosine similarity for each
    const similarities: Array<{ chunkId: string; similarity: number }> = [];

    for (const row of embeddingRows) {
      const embedding = new Float32Array(
        row.embedding.buffer.slice(
          row.embedding.byteOffset,
          row.embedding.byteOffset + row.embedding.byteLength
        )
      );
      const similarity = this.cosineSimilarity(queryEmbedding, embedding);

      if (similarity >= threshold) {
        similarities.push({ chunkId: row.chunk_id, similarity });
      }
    }

    // Step 3: Sort by similarity and take top N
    similarities.sort((a, b) => b.similarity - a.similarity);
    const topMatches = similarities.slice(0, limit);

    if (topMatches.length === 0) {
      return [];
    }

    // Step 4: Get full chunk details for top matches
    const results: Array<{
      chunkId: string;
      similarity: number;
      heading: string;
      content: string;
      articleId: string;
      articleTitle: string;
      articleUrl: string;
      sourceName: string;
      reliabilityTier: 'gold' | 'silver' | 'bronze';
    }> = [];

    for (const match of topMatches) {
      const row = this.db
        .prepare(
          `
          SELECT
            c.id as chunk_id,
            c.heading,
            c.content,
            c.article_id,
            a.title as article_title,
            a.url as article_url,
            s.name as source_name,
            s.reliability_tier
          FROM chunks c
          JOIN articles a ON c.article_id = a.id
          JOIN sources s ON a.source_id = s.id
          WHERE c.id = ?
        `
        )
        .get(match.chunkId) as {
        chunk_id: string;
        heading: string;
        content: string;
        article_id: string;
        article_title: string;
        article_url: string;
        source_name: string;
        reliability_tier: string;
      } | undefined;

      if (row) {
        results.push({
          chunkId: row.chunk_id,
          similarity: match.similarity,
          heading: row.heading,
          content: row.content,
          articleId: row.article_id,
          articleTitle: row.article_title,
          articleUrl: row.article_url,
          sourceName: row.source_name,
          reliabilityTier: row.reliability_tier as 'gold' | 'silver' | 'bronze',
        });
      }
    }

    return results;
  }

  /**
   * Compute cosine similarity between two vectors.
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) {
      return 0;
    }

    return dotProduct / denominator;
  }

  // Curriculum mapping operations
  upsertChunkCurriculum(mapping: ChunkCurriculum): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO chunk_curriculum (chunk_id, program, year, block, topic, relevance)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(mapping.chunkId, mapping.program, mapping.year, mapping.block, mapping.topic, mapping.relevance);
  }

  bulkUpsertChunkCurriculum(mappings: ChunkCurriculum[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO chunk_curriculum (chunk_id, program, year, block, topic, relevance)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((mappings: ChunkCurriculum[]) => {
      for (const mapping of mappings) {
        insert.run(mapping.chunkId, mapping.program, mapping.year, mapping.block, mapping.topic, mapping.relevance);
      }
    });

    transaction(mappings);
  }

  getChunkCurriculum(chunkId: string): ChunkCurriculum[] {
    const rows = this.db
      .prepare('SELECT * FROM chunk_curriculum WHERE chunk_id = ?')
      .all(chunkId) as Array<{
      chunk_id: string;
      program: string;
      year: string;
      block: string;
      topic: string;
      relevance: number;
    }>;
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      program: row.program,
      year: row.year,
      block: row.block,
      topic: row.topic,
      relevance: row.relevance,
    }));
  }

  getChunksByCurriculum(options: {
    program?: string;
    year?: string;
    block?: string;
    topic?: string;
    minRelevance?: number;
    limit?: number;
  }): Array<ChunkCurriculum & { heading: string; content: string; sourceName: string }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.program) {
      conditions.push('cc.program = ?');
      params.push(options.program);
    }
    if (options.year) {
      conditions.push('cc.year = ?');
      params.push(options.year);
    }
    if (options.block) {
      conditions.push('cc.block = ?');
      params.push(options.block);
    }
    if (options.topic) {
      conditions.push('cc.topic = ?');
      params.push(options.topic);
    }
    if (options.minRelevance !== undefined) {
      conditions.push('cc.relevance >= ?');
      params.push(options.minRelevance);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = options.limit ? `LIMIT ${options.limit}` : '';

    const rows = this.db
      .prepare(
        `
      SELECT cc.*, c.heading, c.content, s.name as source_name
      FROM chunk_curriculum cc
      JOIN chunks c ON c.id = cc.chunk_id
      JOIN articles a ON a.id = c.article_id
      JOIN sources s ON s.id = a.source_id
      ${whereClause}
      ORDER BY cc.relevance DESC
      ${limitClause}
    `
      )
      .all(...params) as Array<{
      chunk_id: string;
      program: string;
      year: string;
      block: string;
      topic: string;
      relevance: number;
      heading: string;
      content: string;
      source_name: string;
    }>;

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      program: row.program,
      year: row.year,
      block: row.block,
      topic: row.topic,
      relevance: row.relevance,
      heading: row.heading,
      content: row.content,
      sourceName: row.source_name,
    }));
  }

  getCurriculumStats(): Array<{
    program: string;
    year: string;
    block: string;
    chunkCount: number;
    avgRelevance: number;
  }> {
    const rows = this.db
      .prepare(
        `
      SELECT program, year, block,
             COUNT(DISTINCT chunk_id) as chunk_count,
             AVG(relevance) as avg_relevance
      FROM chunk_curriculum
      GROUP BY program, year, block
      ORDER BY program, year, block
    `
      )
      .all() as Array<{
      program: string;
      year: string;
      block: string;
      chunk_count: number;
      avg_relevance: number;
    }>;

    return rows.map((row) => ({
      program: row.program,
      year: row.year,
      block: row.block,
      chunkCount: row.chunk_count,
      avgRelevance: row.avg_relevance,
    }));
  }

  deleteChunkCurriculum(options: { program?: string; year?: string; block?: string }): number {
    const conditions: string[] = [];
    const params: string[] = [];

    if (options.program) {
      conditions.push('program = ?');
      params.push(options.program);
    }
    if (options.year) {
      conditions.push('year = ?');
      params.push(options.year);
    }
    if (options.block) {
      conditions.push('block = ?');
      params.push(options.block);
    }

    if (conditions.length === 0) {
      throw new Error('Must specify at least one filter for deletion');
    }

    const result = this.db
      .prepare(`DELETE FROM chunk_curriculum WHERE ${conditions.join(' AND ')}`)
      .run(...params);

    return result.changes;
  }

  // Statistics
  getSourceStats(): { sources: number; articles: number; chunks: number } {
    const sources = (this.db.prepare('SELECT COUNT(*) as count FROM sources').get() as { count: number }).count;
    const articles = (this.db.prepare('SELECT COUNT(*) as count FROM articles').get() as { count: number }).count;
    const chunks = (this.db.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number }).count;
    return { sources, articles, chunks };
  }

  getChunkCountBySource(): Array<{ sourceId: string; sourceName: string; count: number }> {
    const rows = this.db
      .prepare(
        `
      SELECT s.id as source_id, s.name as source_name, COUNT(c.id) as count
      FROM sources s
      LEFT JOIN articles a ON a.source_id = s.id
      LEFT JOIN chunks c ON c.article_id = a.id
      GROUP BY s.id
    `
      )
      .all() as Array<{ source_id: string; source_name: string; count: number }>;
    return rows.map((row) => ({
      sourceId: row.source_id,
      sourceName: row.source_name,
      count: row.count,
    }));
  }

  close(): void {
    this.db.close();
  }
}
