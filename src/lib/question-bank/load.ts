import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { CuratedQuestion } from './types';
import { expandContrastSet, validateContrastSet, type ContrastSet } from './contrast-set';
import { applyQuestionImageOverlay } from './image-overlay';
import { validateCuratedQuestion, validateCuratedQuestionBank } from './validate';
import { PublicUsmleProvenanceV1Schema } from '@/lib/usmle/public-corpus';

const CuratedQuestionOptionSchema = z.object({
  label: z.string(),
  text: z.string(),
  isCorrect: z.boolean(),
  misconception: z.string().optional(),
  explanation: z.string().optional(),
});

const CuratedQuestionSchema = z.object({
  id: z.string(),
  sourceFile: z.string().optional(),
  rotation: z.string(),
  moduleNodes: z.array(z.string().trim().min(1)).optional(),
  week: z.number().optional(),
  topics: z.array(z.string()),
  questionType: z.string(),
  difficulty: z.string(),
  stem: z.string(),
  options: z.array(CuratedQuestionOptionSchema),
  context: z.string(),
  imageUrl: z.string().nullable().optional(),
  imageCaption: z.string().nullable().optional(),
  variantGroupId: z.string().nullable().optional(),
  variantType: z.enum(['anchor', 'shuffled', 'rephrased', 'different-scenario', 'near-duplicate', 'contrast-set']).nullable().optional(),
  cite: z.string().nullable().optional(),
  publicUsmle: PublicUsmleProvenanceV1Schema.nullable().optional(),
  crosslinks: z.object({
    primary: z.string().optional(),
    related: z.array(z.string()).optional(),
    concepts: z.array(z.string()).optional(),
  }).nullable().optional(),
  annotations: z.record(z.string()).nullable().optional(),
  abbreviations: z.record(z.string()).nullable().optional(),
  combinations: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()])).nullable().optional(),
  correctVariants: z.array(z.string()).nullable().optional(),
  talk: z.string().nullable().optional(),
}).passthrough();

/** Files with this suffix hold a contrast set rather than plain questions. */
export const CONTRAST_SET_SUFFIX = '.contrast.json';

const ContrastChoiceSchema = z.object({
  key: z.string(),
  text: z.string(),
  explanation: z.string(),
});

const ContrastStemSchema = z.object({
  key: z.string(),
  stem: z.string(),
  correct: z.string(),
  rationale: z.string(),
});

const ContrastSetSchema = z.object({
  id: z.string(),
  rotation: z.string(),
  week: z.number().optional(),
  topics: z.array(z.string()),
  questionType: z.string(),
  difficulty: z.string(),
  cite: z.string().nullable().optional(),
  choices: z.array(ContrastChoiceSchema),
  stems: z.array(ContrastStemSchema),
}).strict();

/**
 * Parse + validate one contrast-set file and expand it to ordinary questions.
 * Returns [] and pushes to `errors` on any problem — a malformed set must never
 * silently emit a partial family.
 */
function expandContrastFile(parsed: unknown, filePath: string, errors: string[]): CuratedQuestion[] {
  const result = ContrastSetSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${filePath}: ${issue.path.join('.')}: ${issue.message}`);
    }
    return [];
  }

  const set = result.data as unknown as ContrastSet;
  const setErrors = validateContrastSet(set);
  if (setErrors.length > 0) {
    for (const e of setErrors) errors.push(`${filePath}: ${e}`);
    return [];
  }

  return expandContrastSet(set, path.relative(process.cwd(), filePath).replace(/\\/g, '/'));
}

export const DEFAULT_QUESTION_BANK_DIR = path.join(process.cwd(), 'question-bank');

export const ROTATION_DIRS = new Set([
  // Year 3 rotations
  'critical-care', 'paam', 'cah', 'pwh',
  // Year 1 KAT exams
  'kat1', 'kat2', 'kat3', 'kat4',
  // Year 2 KAT exams
  'kat5', 'kat6', 'kat7', 'kat8',
  // Clinical skills (MMCA)
  'clinical-skills', 'mmca',
  // USMLE
  'usmle-step1',
  // Cross-rotation core skills
  'year3-common',
  // Supplementary
  'ecg-scaffolding',
  // Personal single-user module (MND exam prep — see study-blend.ts)
  'mnd',
  // Personal licensed AnKing rotation. Bank items are original MD3 companions;
  // private source-deck wording never enters this loader.
  'anking',
]);

/**
 * Top-level question-bank dirs present on disk but DELIBERATELY not loaded.
 * Kept explicit (not just a comment) so the rotation-registry guard test can
 * distinguish an intentional skip from a forgotten registration, and so the
 * loader stays quiet about them.
 */
export const EXCLUDED_ROTATION_DIRS = new Set([
  'year2', // legacy: arrays, no rotation field — incompatible with the curated schema
]);

function listJsonFiles(
  dir: string,
  rootDir: string,
  allowUnregisteredRootDirs: boolean,
): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    // Skip dotfiles / dotdirs and _metadata files
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    // Only load curated bank questions for registered rotations. An UNregistered
    // dir would otherwise be skipped silently and drop all its MCQs — warn loudly
    // (unless it's an explicit deliberate exclusion).
    if (
      entry.isDirectory()
      && dir === rootDir
      && !allowUnregisteredRootDirs
      && !ROTATION_DIRS.has(entry.name)
    ) {
      if (!EXCLUDED_ROTATION_DIRS.has(entry.name)) {
        console.warn(
          `[question-bank] skipping unregistered dir '${entry.name}' — its questions will NOT load. ` +
            `Add it to ROTATION_DIRS in src/lib/question-bank/load.ts (or EXCLUDED_ROTATION_DIRS if intentional).`,
        );
      }
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(fullPath, rootDir, allowUnregisteredRootDirs));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    files.push(fullPath);
  }

  return files;
}

export function loadQuestionBankFromDisk(options: {
  bankDir?: string;
  /**
   * Permit a domain tree such as `questions/<domain>/<item>.json`.
   * Defaults false so the private-bank rotation registry remains fail-closed.
   */
  allowUnregisteredRootDirs?: boolean;
} = {}): {
  bankDir: string;
  files: string[];
  questions: CuratedQuestion[];
  errors: string[];
} {
  const bankDir = options.bankDir ?? DEFAULT_QUESTION_BANK_DIR;

  if (!fs.existsSync(bankDir)) {
    // Sentinel error (not silent-empty): a missing bankDir — e.g. an unresolved
    // `question-bank` symlink in a worktree (the 2026-06-11 incident) — must NOT
    // be treated as "zero questions", which would retire the entire live bank at
    // seed time. Callers that gate on errors.length will now throw instead.
    return {
      bankDir,
      files: [],
      questions: [],
      errors: [`${bankDir}: question-bank directory not found — refusing to treat as empty (would retire the entire bank).`],
    };
  }

  const files = listJsonFiles(
    bankDir,
    bankDir,
    options.allowUnregisteredRootDirs === true,
  ).sort();
  const questions: CuratedQuestion[] = [];
  const errors: string[] = [];

  for (const filePath of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      errors.push(`${filePath}: invalid JSON (${err instanceof Error ? err.message : 'unknown error'})`);
      continue;
    }

    // A *.contrast.json file holds ONE contrast set (a shared choice pool + N stems,
    // each with a different correct answer). Expand it here, at the very top of the
    // pipeline, so every generated stem is an ordinary question from this point on and
    // the entire quality floor below — validateCuratedQuestion, checkLengthBias,
    // analyzeGuessability, the flag detectors, seeding, embedding — runs on it
    // unchanged. Expanding later (or at render, as the abandoned correctVariants path
    // did) puts generated content where no validator can see it.
    // See src/lib/question-bank/contrast-set.ts.
    const items: unknown[] = filePath.endsWith(CONTRAST_SET_SUFFIX)
      ? expandContrastFile(parsed, filePath, errors)
      : Array.isArray(parsed)
        ? parsed
        : [parsed];

    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`${filePath}: expected question object, got ${typeof item}`);
        continue;
      }

      const parseResult = CuratedQuestionSchema.safeParse(
        applyQuestionImageOverlay(
          item as Record<string, unknown> & {
            id: string;
            imageUrl?: string | null;
          },
        ),
      );
      if (!parseResult.success) {
        for (const issue of parseResult.error.issues) {
          errors.push(`${filePath}: ${issue.path.join('.')}: ${issue.message}`);
        }
        continue;
      }

      const q = {
        ...parseResult.data,
        sourceFile: path.relative(process.cwd(), filePath).replace(/\\/g, '/'),
      } as CuratedQuestion;
      const qErrors = validateCuratedQuestion(q);
      if (qErrors.length > 0) {
        for (const e of qErrors) errors.push(`${filePath}: ${e}`);
        continue;
      }

      questions.push(q);
    }
  }

  // Cross-file validation (duplicate IDs, etc.)
  const bankErrors = validateCuratedQuestionBank(questions);
  for (const e of bankErrors) errors.push(`${bankDir}: ${e}`);

  return { bankDir, files, questions, errors };
}
