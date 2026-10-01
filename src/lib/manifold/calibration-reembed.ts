/**
 * Re-embed calibration sources at the canonical embedding dim.
 *
 * Legacy operator calibration files (`example/source-a/calibration-embeddings*.json`)
 * were generated with OpenAI text-embedding-3-small (1536D). Card/question
 * embeddings are Gemini II at 3072D halfvec. pgvector cosine requires
 * matching dims, so the legacy files can't be scored against bank items.
 *
 * This module reads the verbatim source-questions file from a calibration
 * source dir, runs each question's stem through an injected embedder
 * (Gemini II in production, a deterministic mock in tests), and writes
 * `calibration-embeddings-verbatim.json` in the shape the loader expects.
 *
 * The embedder is injected so tests don't hit the live API. The CLI in
 * `scripts/manifold/reembed-calibration.ts` wires the Gemini implementation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CalibrationEmbedder {
  model: string;
  dimensions: number;
  embed(text: string): Promise<number[]>;
}

interface SourceQuestion {
  stem: string;
  question_number?: number;
  domain?: string;
  options?: Array<{ label: string; text: string }>;
}

interface SourceFile {
  exam?: string;
  extracted_questions?: SourceQuestion[];
  questions?: SourceQuestion[];
}

export interface ReembedOptions {
  /** Re-embed even when the output file is newer than the source. */
  force?: boolean;
  /**
   * Do not write the output file. Still runs the embedder so callers can
   * observe what *would* happen (cost, error rate) without mutating disk.
   * The dry-run path is a CLI ergonomic — pair with a no-op embedder so
   * even the embedder doesn't make API calls.
   */
  dryRun?: boolean;
}

export interface ReembedResult {
  ok: boolean;
  embedded: number;
  skipped: number;
  errors: string[];
  outputPath?: string;
}

/**
 * Build the text we send to the embedder for a single question.
 * Includes options when present so the embedding captures distractor framing,
 * not just stem topic.
 */
export function formatQuestionForEmbedding(q: SourceQuestion): string {
  if (!q.options || q.options.length === 0) return q.stem;
  const optionLines = q.options.map((opt) => `${opt.label}: ${opt.text}`).join('\n');
  return `${q.stem}\n\n${optionLines}`;
}

const SOURCE_FILENAMES = ['exam-questions-verbatim.json', 'sample-questions.json'];
const OUTPUT_FILENAME = 'calibration-embeddings-verbatim.json';

function findSourceFile(dir: string): string | null {
  for (const name of SOURCE_FILENAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readSourceQuestions(filePath: string): { exam: string; questions: SourceQuestion[] } {
  const raw: SourceFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const questions = raw.extracted_questions || raw.questions || [];
  return { exam: raw.exam || path.basename(path.dirname(filePath)), questions };
}

export async function reembedCalibrationSource(
  sourceDir: string,
  embedder: CalibrationEmbedder,
  options: ReembedOptions = {},
): Promise<ReembedResult> {
  const errors: string[] = [];
  const sourceFile = findSourceFile(sourceDir);
  if (!sourceFile) {
    return { ok: false, embedded: 0, skipped: 0, errors: ['No source-questions file found'] };
  }

  const outputPath = path.join(sourceDir, OUTPUT_FILENAME);
  const { exam, questions } = readSourceQuestions(sourceFile);

  // Idempotency: skip when output is newer than source AND matches the
  // current embedder's model + dimensions. force=true bypasses both.
  if (!options.force && fs.existsSync(outputPath)) {
    const outStat = fs.statSync(outputPath);
    const srcStat = fs.statSync(sourceFile);
    if (outStat.mtimeMs >= srcStat.mtimeMs) {
      try {
        const existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
        if (existing.embedding_model === embedder.model && existing.dimensions === embedder.dimensions) {
          return { ok: true, embedded: 0, skipped: questions.length, errors: [], outputPath };
        }
      } catch {
        // fall through to re-embed
      }
    }
  }

  const embeddedQuestions: Array<SourceQuestion & { embedding: number[] }> = [];
  for (const q of questions) {
    try {
      const text = formatQuestionForEmbedding(q);
      const embedding = await embedder.embed(text);
      embeddedQuestions.push({
        question_number: q.question_number,
        stem: q.stem,
        domain: q.domain || '',
        embedding,
      });
    } catch (error) {
      const qid = q.question_number ?? '?';
      errors.push(`question ${qid}: ${String(error)}`);
    }
  }

  const output = {
    exam,
    generated_at: new Date().toISOString(),
    embedding_model: embedder.model,
    dimensions: embedder.dimensions,
    question_count: embeddedQuestions.length,
    questions: embeddedQuestions,
  };
  if (!options.dryRun) {
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  }

  return {
    ok: embeddedQuestions.length > 0,
    embedded: embeddedQuestions.length,
    skipped: 0,
    errors,
    outputPath: options.dryRun ? undefined : outputPath,
  };
}
