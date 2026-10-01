import fs from 'fs';
import path from 'path';

/**
 * A practice-exam item is not a bank Question, so its flags are filed as
 * `component` issues addressed `practice-exam:<paperId>:<itemId>`. Triage
 * resolves that id back to the published paper file so the flag shows the
 * stem and key instead of "unknown".
 */
export interface PracticeExamTarget {
  paperId: string;
  itemId: string;
}

export interface ResolvedPracticeExamItem {
  filePath: string;
  rotation: string;
  stem: string;
  options: Array<{ label: string; text: string; isCorrect: boolean; explanation?: string }>;
  explanation: string;
}

const TARGET = /^practice-exam:([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)$/;

export function parsePracticeExamTarget(targetId: string): PracticeExamTarget | null {
  const match = TARGET.exec(targetId);
  return match ? { paperId: match[1], itemId: match[2] } : null;
}

export function resolvePracticeExamTarget(targetId: string, rootDir: string): ResolvedPracticeExamItem | null {
  const target = parsePracticeExamTarget(targetId);
  if (!target) return null;
  const filePath = path.posix.join('content/practice-exams', `${target.paperId}.json`);
  let paper: { rotation?: string; items?: Array<Record<string, unknown>> };
  try {
    paper = JSON.parse(fs.readFileSync(path.join(rootDir, filePath), 'utf8'));
  } catch {
    return null;
  }
  const item = paper.items?.find((candidate) => candidate.id === target.itemId);
  if (!item) return null;
  const options = (item.options as string[]).map((text, index) => ({
    label: String.fromCharCode(65 + index),
    text,
    isCorrect: index === item.answerIndex,
    explanation: (item.explanations as string[] | undefined)?.[index],
  }));
  return {
    filePath,
    rotation: paper.rotation ?? 'unknown',
    stem: String(item.stem ?? ''),
    options,
    explanation: String(item.keyPoint ?? ''),
  };
}
