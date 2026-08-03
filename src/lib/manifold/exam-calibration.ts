/**
 * Exam Calibration — Multi-Source Content Relevance Scoring
 *
 * Loads operator-supplied exam-anchor embeddings from a configured directory and
 * scores arbitrary content embeddings against them. Supports multiple
 * concurrent sources (CC, CAH, PWH, USMLE) — each source is a directory
 * containing a `calibration-embeddings*.json` file and an optional
 * `manifest.json` declaring its rotation + exam metadata.
 *
 * Layout convention:
 *   <calibration-root>/<scope>/<source>/
 *     manifest.json                            (optional: { rotation, exam, ... })
 *     calibration-embeddings.json              (topic-shaped) OR
 *     calibration-embeddings-verbatim.json     (question-shaped)
 *
 * Source key = relative path from CALIBRATION_ROOT (e.g. `example/source-a`).
 * Rotation routing is opt-in via manifest; sources without a manifest are
 * still loadable by sourceKey but won't match `{rotation: ...}` queries.
 *
 * Ethical model: exam questions never enter the user-facing DB. The loader
 * reads embeddings only; the verbatim files exist to support recalibration
 * and must remain outside the public source distribution.
 */
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@/lib/logger';

// ─── Types ───

interface CalibrationTopic {
  text: string;
  domain: string;
  embedding: number[];
}

export interface CalibrationData {
  sourceKey: string;
  exam: string;
  rotation: string | null;
  generated_at: string;
  embedding_model: string;
  dimensions: number;
  topics: CalibrationTopic[];
}

export interface CalibrationSourceInfo {
  sourceKey: string;
  rotation: string | null;
  exam: string;
  generatedAt: string;
  topicCount: number;
}

export interface CalibrationLookupOpts {
  /** Restrict to a specific source by its key (relative path under root). */
  sourceKey?: string;
  /** Restrict to sources whose manifest declares this rotation. */
  rotation?: string;
  /** Override the calibration root (used by tests + the env var). */
  calibrationRoot?: string;
}

// ─── Roots / caches ───

/** Per-root listing cache. Cleared by _resetCalibrationCache(). */
const listCache = new Map<string, CalibrationSourceInfo[]>();
/** Per-(root + sourceKey) data cache. Cleared by _resetCalibrationCache(). */
const dataCache = new Map<string, CalibrationData | null>();

/** Test-only: clear all caches. Exposed for vitest beforeAll/afterAll. */
export function _resetCalibrationCache(): void {
  listCache.clear();
  dataCache.clear();
}

// ─── Source discovery ───

function resolveRoot(opts: CalibrationLookupOpts | undefined): string {
  if (opts?.calibrationRoot) return opts.calibrationRoot;

  const resolveCalibrationRoot = (basePath: string): string => {
    const direct = path.resolve(basePath);
    const nestedCalibrationRoot = path.join(direct, 'calibration');
    if (path.basename(direct) !== 'calibration' && fs.existsSync(nestedCalibrationRoot)) {
      return nestedCalibrationRoot;
    }
    return direct;
  };

  const envPath = process.env.CALIBRATION_PATH;
  if (envPath) {
    return resolveCalibrationRoot(envPath);
  }

  // Public-safe default: an empty local directory inside the deployment. Private
  // operators must opt in explicitly with CALIBRATION_PATH; no user home or
  // sibling private tree is probed implicitly.
  return resolveCalibrationRoot(path.resolve(process.cwd(), '.md3-calibration'));
}

const EMBEDDING_FILENAMES = [
  'calibration-embeddings-verbatim.json',
  'calibration-embeddings.json',
];

function findEmbeddingFile(dir: string): string | null {
  for (const name of EMBEDDING_FILENAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

interface Manifest {
  rotation?: string;
  exam?: string;
}

function readManifest(dir: string): Manifest {
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (error) {
    logger.warn('Failed to parse manifest.json', { dir, error: String(error) });
    return {};
  }
}

/**
 * Recursively walk `root` looking for directories that contain one of the
 * EMBEDDING_FILENAMES files. Each such directory is a calibration source.
 */
function discoverSources(root: string): CalibrationSourceInfo[] {
  if (!fs.existsSync(root)) return [];
  const sources: CalibrationSourceInfo[] = [];

  function walk(dir: string) {
    const embFile = findEmbeddingFile(dir);
    if (embFile) {
      const sourceKey = path.relative(root, dir).split(path.sep).join('/');
      const manifest = readManifest(dir);
      let topicCount = 0;
      let exam = manifest.exam || sourceKey;
      let generatedAt = '';
      try {
        const raw = JSON.parse(fs.readFileSync(embFile, 'utf-8'));
        topicCount = (raw.topics?.length) ?? (raw.questions?.length) ?? 0;
        exam = manifest.exam || raw.exam || sourceKey;
        generatedAt = raw.generated_at || '';
      } catch (error) {
        logger.warn('Failed to peek at calibration file for listing', { embFile, error: String(error) });
      }
      sources.push({
        sourceKey,
        rotation: manifest.rotation ?? null,
        exam,
        generatedAt,
        topicCount,
      });
      return; // don't recurse into a source dir
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        walk(path.join(dir, entry.name));
      }
    }
  }

  walk(root);
  return sources.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

export function listCalibrationSources(opts?: CalibrationLookupOpts): CalibrationSourceInfo[] {
  const root = resolveRoot(opts);
  let cached = listCache.get(root);
  if (!cached) {
    cached = discoverSources(root);
    listCache.set(root, cached);
  }
  if (opts?.sourceKey) return cached.filter((s) => s.sourceKey === opts.sourceKey);
  if (opts?.rotation) return cached.filter((s) => s.rotation === opts.rotation);
  return cached;
}

// ─── Per-source loading ───

export function loadCalibrationSource(
  sourceKey: string,
  opts?: CalibrationLookupOpts,
): CalibrationData | null {
  const root = resolveRoot(opts);
  const cacheKey = `${root}::${sourceKey}`;
  if (dataCache.has(cacheKey)) return dataCache.get(cacheKey) ?? null;

  const dir = path.join(root, sourceKey);
  const embFile = findEmbeddingFile(dir);
  if (!embFile) {
    dataCache.set(cacheKey, null);
    return null;
  }
  const manifest = readManifest(dir);

  try {
    const raw = JSON.parse(fs.readFileSync(embFile, 'utf-8'));
    const topics: CalibrationTopic[] =
      raw.topics
      || raw.questions?.map((q: { stem: string; domain: string; embedding: number[] }) => ({
        text: q.stem,
        domain: q.domain,
        embedding: q.embedding,
      }))
      || [];
    const data: CalibrationData = {
      sourceKey,
      exam: manifest.exam || raw.exam || sourceKey,
      rotation: manifest.rotation ?? null,
      generated_at: raw.generated_at || '',
      embedding_model: raw.embedding_model || '',
      dimensions: raw.dimensions || (topics[0]?.embedding.length ?? 0),
      topics,
    };
    dataCache.set(cacheKey, data);
    return data;
  } catch (error) {
    logger.error('Failed to load calibration source', { sourceKey, embFile, error: String(error) });
    dataCache.set(cacheKey, null);
    return null;
  }
}

// ─── Scoring ───

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface ScoreResult {
  score: number;
  topDomains: Array<{ domain: string; similarity: number }>;
  /** Per-source max similarity. */
  perSource: Record<string, number>;
}

export interface ExamSimilarity {
  domain: string;
  similarity: number;
  sourceKey: string;
}

export function summarizeExamSimilarities(
  similarities: ExamSimilarity[],
  sourceKeys: string[] = [],
): ScoreResult {
  const perSource: Record<string, number> = {};
  for (const sourceKey of sourceKeys) {
    perSource[sourceKey] = 0;
  }

  for (const s of similarities) {
    const current = perSource[s.sourceKey] ?? 0;
    if (s.similarity > current) perSource[s.sourceKey] = s.similarity;
  }

  if (similarities.length === 0) return { score: 0, topDomains: [], perSource };

  const sorted = [...similarities].sort((a, b) => b.similarity - a.similarity);
  const maxSim = sorted[0].similarity;
  const topN = sorted.slice(0, 3);
  const avgTop3 = topN.reduce((s, x) => s + x.similarity, 0) / topN.length;
  const score = maxSim * 0.6 + avgTop3 * 0.4;

  const domainScores = new Map<string, number>();
  for (const s of sorted) {
    if (!domainScores.has(s.domain) || domainScores.get(s.domain)! < s.similarity) {
      domainScores.set(s.domain, s.similarity);
    }
  }
  const topDomains = [...domainScores.entries()]
    .map(([domain, similarity]) => ({ domain, similarity }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  return { score, topDomains, perSource };
}

/**
 * Score a content embedding against one or more calibration sources.
 *
 * - `{sourceKey}`: score against that single source.
 * - `{rotation}`: aggregate across all sources whose manifest declares this rotation.
 * - no scope: aggregate across every loadable source under the root.
 *
 * Returns the blended max+top3-avg score AND per-source max scores so callers
 * can persist a per-source breakdown (e.g. Card.examRelevance JSON column).
 */
export function scoreExamRelevance(
  contentEmbedding: number[],
  opts?: CalibrationLookupOpts,
): ScoreResult {
  const sources = listCalibrationSources(opts);
  if (sources.length === 0) return { score: 0, topDomains: [], perSource: {} };

  const allSimilarities: ExamSimilarity[] = [];

  for (const src of sources) {
    const data = loadCalibrationSource(src.sourceKey, opts);
    if (!data) continue;
    for (const topic of data.topics) {
      const sim = cosineSimilarity(contentEmbedding, topic.embedding);
      allSimilarities.push({ domain: topic.domain, similarity: sim, sourceKey: src.sourceKey });
    }
  }

  return summarizeExamSimilarities(allSimilarities, sources.map((s) => s.sourceKey));
}

export function batchScoreExamRelevance(
  embeddings: number[][],
  opts?: CalibrationLookupOpts,
): ScoreResult[] {
  return embeddings.map((e) => scoreExamRelevance(e, opts));
}

// ─── Aggregate info ───

export function hasExamCalibration(opts?: CalibrationLookupOpts): boolean {
  return listCalibrationSources(opts).length > 0;
}

export interface CalibrationAggregateInfo {
  sources: CalibrationSourceInfo[];
  sourceCount: number;
  totalTopicCount: number;
  rotations: string[];
}

export function getCalibrationInfo(opts?: CalibrationLookupOpts): CalibrationAggregateInfo | null {
  const sources = listCalibrationSources(opts);
  if (sources.length === 0) return null;
  return {
    sources,
    sourceCount: sources.length,
    totalTopicCount: sources.reduce((s, x) => s + x.topicCount, 0),
    rotations: [...new Set(sources.map((s) => s.rotation).filter(Boolean) as string[])],
  };
}
