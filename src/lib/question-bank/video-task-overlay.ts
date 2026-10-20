import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CuratedQuestion, CuratedQuestionOption } from './types';
import { validateClipTaskReviews, type ClipTaskInput } from '../video/clip-task-review';

export const DEFAULT_QUESTION_VIDEO_REPAIRS_PATH = path.join(process.cwd(), 'content', 'question-video-repairs.json');

export interface QuestionVideoRepair {
  originalFingerprint: string;
  stem?: string;
  context?: string;
  options?: CuratedQuestionOption[];
  clipSlug?: string | null;
  clipRole?: 'prompt' | null;
  clipCaption?: string | null;
}

export interface QuestionVideoRepairFile {
  schemaVersion: 1;
  legacyFingerprints: string[];
  repairs: Record<string, QuestionVideoRepair>;
}

function canonicalQuestion(question: Pick<CuratedQuestion, 'id' | 'rotation' | 'stem' | 'context' | 'options' | 'clipSlug' | 'clipRole' | 'clipCaption'>): string {
  const options = question.options.map((option) => ({
    label: option.label,
    text: option.text,
    isCorrect: option.isCorrect,
    misconception: option.misconception ?? null,
    explanation: option.explanation ?? null,
  }));
  return JSON.stringify({
    rotation: (question as CuratedQuestion).rotation,
    sourceFile: `question-bank:${question.id}`,
    front: JSON.stringify({ stem: question.stem, options }),
    back: JSON.stringify(options.filter((option) => option.isCorrect)),
    context: question.context,
    clipSlug: question.clipSlug ?? null,
    clipRole: question.clipRole ?? null,
    clipCaption: question.clipCaption ?? null,
  });
}

export function questionVideoFingerprint(question: Pick<CuratedQuestion, 'id' | 'rotation' | 'stem' | 'context' | 'options' | 'clipSlug' | 'clipRole' | 'clipCaption'>): string {
  return createHash('sha256').update(canonicalQuestion(question)).digest('hex');
}

export function loadQuestionVideoRepairs(filePath = DEFAULT_QUESTION_VIDEO_REPAIRS_PATH): QuestionVideoRepairFile {
  if (!fs.existsSync(filePath)) return { schemaVersion: 1, legacyFingerprints: [], repairs: {} };
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<QuestionVideoRepairFile>;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.legacyFingerprints) || !parsed.repairs || typeof parsed.repairs !== 'object') {
    throw new Error(`Invalid question video repair file: ${filePath}`);
  }
  for (const fingerprint of parsed.legacyFingerprints) {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Error(`Invalid question video legacy fingerprint in ${filePath}`);
  }
  for (const [id, repair] of Object.entries(parsed.repairs)) {
    if (!repair || typeof repair !== 'object' || !/^[a-f0-9]{64}$/i.test(repair.originalFingerprint)) {
      throw new Error(`Invalid question video repair entry '${id}' in ${filePath}`);
    }
    if (repair.options !== undefined && !Array.isArray(repair.options)) throw new Error(`Invalid options in question video repair '${id}'`);
    if (repair.clipRole !== undefined && repair.clipRole !== null && repair.clipRole !== 'prompt') throw new Error(`Invalid clipRole in question video repair '${id}'`);
  }
  return parsed as QuestionVideoRepairFile;
}

export function applyQuestionVideoRepair(question: CuratedQuestion, file = loadQuestionVideoRepairs()): CuratedQuestion {
  const repair = file.repairs[question.id];
  if (!repair) return question;
  const actual = questionVideoFingerprint(question);
  if (actual !== repair.originalFingerprint) {
    throw new Error(`Question video repair for ${question.id} is stale: source fingerprint changed`);
  }
  return {
    ...question,
    ...(repair.stem !== undefined ? { stem: repair.stem } : {}),
    ...(repair.context !== undefined ? { context: repair.context } : {}),
    ...(repair.options !== undefined ? { options: repair.options } : {}),
    ...(repair.clipSlug !== undefined ? { clipSlug: repair.clipSlug } : {}),
    ...(repair.clipRole !== undefined ? { clipRole: repair.clipRole } : {}),
    ...(repair.clipCaption !== undefined ? { clipCaption: repair.clipCaption } : {}),
  };
}

export function questionClipTaskInput(question: CuratedQuestion): ClipTaskInput {
  const correct = question.options.filter((option) => option.isCorrect).map((option) => ({
    label: option.label,
    text: option.text,
    isCorrect: option.isCorrect,
    misconception: option.misconception ?? null,
    explanation: option.explanation ?? null,
  }));
  return {
    rotation: question.rotation,
    sourceFile: `question-bank:${question.id}`,
    front: JSON.stringify({ stem: question.stem, options: question.options.map((option) => ({ label: option.label, text: option.text, isCorrect: option.isCorrect, misconception: option.misconception ?? null, explanation: option.explanation ?? null })) }),
    back: JSON.stringify(correct),
    context: question.context,
    clipSlug: question.clipSlug,
    clipRole: question.clipRole,
    clipCaption: question.clipCaption,
  };
}

export function assertQuestionClipTaskReviews(questions: readonly CuratedQuestion[], ledger: unknown, repairs = loadQuestionVideoRepairs()): void {
  const clipQuestions = questions.filter((question) => question.clipSlug?.trim());
  const result = validateClipTaskReviews(clipQuestions.map(questionClipTaskInput), {
    ...ledger as Record<string, unknown>,
    legacyFingerprints: [
      ...((ledger as { legacyFingerprints?: string[] }).legacyFingerprints ?? []),
      ...repairs.legacyFingerprints,
    ],
  });
  if (result.findings.length > 0) {
    throw new Error(`Question video task review gate failed (${result.findings.length} finding(s)):\n${result.findings.slice(0, 20).map((finding) => `- ${finding.code}: ${finding.message}`).join('\n')}`);
  }
}
