import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeAnswerAtMarkdownBoundary } from '../qa-boundaries';

export interface MdxAuthoringFinding {
  code:
    | 'ANSWER_BULLET_LEAK'
    | 'SEMICOLON_SINGLE_BLANK'
    | 'SEMICOLON_MULTI_MISMATCH'
    | 'UNCLOSED_CONTEXT_ATTR'
    | 'FAKE_CLOZE_NO_BLANK';
  message: string;
  line: number;
}

export interface MdxAuthoringFileFinding extends MdxAuthoringFinding {
  file: string;
}

const QA_REGEX = /\*\*Q:\*\*\s*([\s\S]*?)\s*\*\*A:\*\*\s*([\s\S]*?)(?=\s*\*\*Q:\*\*|\s*$)/gi;

function getLineNumber(content: string, startIndex: number): number {
  return content.slice(0, startIndex).split('\n').length;
}

function splitAnswerCandidates(answer: string): string[] {
  return answer
    .split(/[;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Detect `context="..."` JSX attributes whose closing quote is missing.
 * The seeder regex `context="([^"]*)"` will skip ahead to the next `"`
 * anywhere in the file, swallowing downstream KeyPoints into the broken
 * attribute and corrupting subsequent cards (cards starting mid-sentence,
 * contexts ending in raw markdown / `<KeyPoint context="`). Caught Pattern D
 * in 2026-05-05 user-flag triage; promoted to a hard pre-seed gate.
 */
function scanUnclosedContextAttrs(content: string): MdxAuthoringFinding[] {
  const findings: MdxAuthoringFinding[] = [];
  const positions: number[] = [];
  let pos = 0;
  while ((pos = content.indexOf('context="', pos)) !== -1) {
    positions.push(pos);
    pos += 9;
  }
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i] + 9;
    const next = i + 1 < positions.length ? positions[i + 1] : content.length;
    const closeQ = content.indexOf('"', start);
    if (closeQ === -1 || closeQ >= next) {
      findings.push({
        code: 'UNCLOSED_CONTEXT_ATTR',
        message:
          'context="..." attribute is missing its closing quote — the seeder will swallow downstream KeyPoints',
        line: getLineNumber(content, positions[i]),
      });
    }
  }
  return findings;
}

export function scanMdxAuthoringBlockers(content: string): MdxAuthoringFinding[] {
  const findings: MdxAuthoringFinding[] = [];
  findings.push(...scanUnclosedContextAttrs(content));
  let match: RegExpExecArray | null;

  while ((match = QA_REGEX.exec(content)) !== null) {
    const question = match[1].trim();
    const answer = match[2].trim();
    // Decode HTML entities before analysis (e.g. &lt; contains ';' which confuses semicolon checks)
    const decodedAnswer = answer.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const { answer: answerForCounting, boundaryKind } = analyzeAnswerAtMarkdownBoundary(decodedAnswer);
    const line = getLineNumber(content, match.index);
    const blankCount = (question.match(/\[___\]|\[\\_\\_\\_\]/g) ?? []).length;

    if (boundaryKind === 'unordered-list' || boundaryKind === 'ordered-list') {
      findings.push({
        code: 'ANSWER_BULLET_LEAK',
        message: 'Answer continues directly into bullet/list teaching notes',
        line,
      });
    }

    // Pattern A from 2026-05-05 user-flag triage: Q/A block with zero blanks
    // is a "fake cloze" — the seeder will produce a degenerate card whose
    // front is a question and whose back is a list with no recall mechanic.
    // Convert to MCQ or add [___] blanks instead.
    if (blankCount === 0) {
      findings.push({
        code: 'FAKE_CLOZE_NO_BLANK',
        message:
          'Q/A block has no [___] blanks — convert to MCQ or add explicit cloze deletions',
        line,
      });
      continue;
    }

    if (blankCount <= 1) {
      if (!answerForCounting.includes(';')) continue;
      findings.push({
        code: 'SEMICOLON_SINGLE_BLANK',
        message: 'Single-blank Q/A answer should not use semicolon-delimited multi-answer content',
        line,
      });
      continue;
    }

    const parts = splitAnswerCandidates(answerForCounting);
    if (parts.length !== blankCount) {
      findings.push({
        code: 'SEMICOLON_MULTI_MISMATCH',
        message: `Multi-blank answer count (${parts.length}) does not match blank count (${blankCount}); use semicolon-delimited answers`,
        line,
      });
    }
  }

  return findings;
}

function walkMdxFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMdxFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.mdx')) {
      files.push(fullPath);
    }
  }

  return files;
}

export function scanMdxAuthoringBlockersInDir(contentDir: string): MdxAuthoringFileFinding[] {
  const findings: MdxAuthoringFileFinding[] = [];
  const files = walkMdxFiles(contentDir);

  for (const filePath of files) {
    const relPath = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    for (const finding of scanMdxAuthoringBlockers(content)) {
      findings.push({
        ...finding,
        file: relPath,
      });
    }
  }

  return findings;
}
