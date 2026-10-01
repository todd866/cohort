/**
 * Content Lake Types
 *
 * Types for the certification layer that backs every card with deep, verifiable citations.
 */

export interface Source {
  id: string;
  name: string;
  baseUrl: string;
  reliabilityTier: 'gold' | 'silver' | 'bronze';  // gold: guidelines, silver: established resources, bronze: educational
  lastCrawl: Date;
}

export interface Article {
  id: string;
  sourceId: string;
  url: string;
  title: string;
  markdown: string;
  publishedDate?: Date;
  crawledAt: Date;
}

export interface Chunk {
  id: string;                    // 'ibcc:sepsis:chunk-42'
  articleId: string;
  heading: string;               // Section heading this chunk is under
  content: string;               // Raw text (searchable)
  contentHash: string;           // For dedup detection
  charOffsetStart: number;       // Position in original article
  charOffsetEnd: number;
  wordCount: number;
}

export interface ChunkEmbedding {
  chunkId: string;
  embedding: Float32Array;
}

export interface CrossRef {
  factHash: string;              // Normalized fact content
  chunkId: string;               // Which chunks contain this fact
  confidence: number;            // How certain is the match (0-1)
}

export interface CardCitation {
  cardId: string;
  chunkId: string;
  citationType: 'supports' | 'derived_from';
}

// Curriculum mapping - links chunks to program/year/block/topic
export interface ChunkCurriculum {
  chunkId: string;
  program: string;        // 'usyd-md', 'usmle'
  year: string;           // 'md1', 'md2', 'md3' or 'step1'
  block: string;          // 'foundations', 'critical-care', etc.
  topic: string;          // 'cardiovascular', 'respiratory', etc.
  relevance: number;      // 0-1 score from semantic matching
}

// Curriculum definition for mapping
export interface CurriculumBlock {
  program: string;
  year: string;
  block: string;
  topics: string[];       // Topics covered in this block
  keywords: string[];     // Keywords for semantic matching
}

// Extraction result from HTML
export interface ExtractionResult {
  title: string;
  url: string;
  markdown: string;
  sections: Section[];
}

export interface Section {
  heading: string;
  level: number;           // h1=1, h2=2, etc.
  content: string;
  charOffsetStart: number;
  charOffsetEnd: number;
}

// Source-specific extractor interface
export interface Extractor {
  name: string;
  canExtract(html: string, url: string): boolean;
  extract(html: string, url: string): ExtractionResult;
}

// PDF source configuration
export interface PDFSource {
  id: string;
  name: string;
  baseUrl: string;
  reliabilityTier: 'gold' | 'silver' | 'bronze';
  pdfDir: string;
  urlPattern: (filename: string) => string;
}
