#!/usr/bin/env node
/** Generate the authored Cohort question lane without touching mirrored artifacts. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { buildOriginalModuleArtifacts, moduleReleaseFingerprints, moduleSourceFingerprint, type CohortModuleQuestionFile } from '../../src/lib/content/cohort-module-corpus';
import {
  DEFAULT_COHORT_ORIGINAL_QUESTION_ROOT,
  loadCohortOriginalQuestionsFromDisk,
  originalQuestionManifest,
  type LoadedOriginalQuestion,
} from '../../src/lib/content/cohort-original-questions';
import type { VerifiedReferenceEntry } from '../../src/lib/content/cohort-module-corpus';
import type { CuratedQuestion } from '../../src/lib/question-bank/types';

const ROOT = resolve(__dirname, '..', '..');
const ORIGINAL_MODULES = 'open-content/modules/original-questions';
const ORIGINAL_RELEASE = 'open-content/modules/original-questions-release-v1.json';
const ORIGINAL_SOURCES = 'open-content/modules/original-questions-sources.json';
const ORIGINAL_MANIFEST = 'open-content/modules/original-question-ids-v1.json';

export interface OriginalQuestionCheck { root: string; files: number; questions: number; errors: string[]; ok: boolean }
export function checkOriginalQuestions(root = DEFAULT_COHORT_ORIGINAL_QUESTION_ROOT): OriginalQuestionCheck {
  const loaded = loadCohortOriginalQuestionsFromDisk({ root });
  return { root, files: loaded.files.length, questions: loaded.questions.length, errors: loaded.errors, ok: loaded.errors.length === 0 };
}

function sourceId(url: string): string { return `original-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`; }
function referenceInputs(questions: readonly LoadedOriginalQuestion[]): { items: Array<{ question: LoadedOriginalQuestion['question']; sourceId: string; originalId: string }>; references: Record<string, VerifiedReferenceEntry> } {
  const references: Record<string, VerifiedReferenceEntry> = {};
  const items = questions.map((loaded) => {
    const id = sourceId(loaded.question.reference.url ?? loaded.question.reference.title ?? loaded.originalId);
    references[id] = { title: loaded.question.reference.title ?? 'Source', publisher: loaded.question.reference.publisher ?? null, url: loaded.question.reference.url!, verifiedAt: '2026-10-06' };
    return { question: loaded.question, sourceId: id, originalId: loaded.originalId };
  });
  return { items, references };
}
function walk(dir: string): string[] { if (!existsSync(dir)) return []; return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => { const abs = join(dir, entry.name); return entry.isDirectory() ? walk(abs) : [abs]; }); }
function servingFingerprints(files: ReadonlyMap<string, CohortModuleQuestionFile>): Record<string, string> {
  const questions = [...files].map(([sourceFile, file]) => ({
    id: file.id, sourceFile, rotation: file.rotation, moduleNodes: file.moduleNodes, topics: file.topics,
    questionType: file.questionType, difficulty: file.difficulty, stem: file.stem, options: file.options,
    context: file.context,
  } as unknown as CuratedQuestion));
  return moduleReleaseFingerprints(questions);
}

export function syncOriginalQuestions(root: string, write: boolean, repoRoot = ROOT): { changed: string[]; stale: string[]; count: number } {
  const loaded = loadCohortOriginalQuestionsFromDisk({ root });
  if (loaded.errors.length) throw new Error(`original Cohort questions failed validation:\n${loaded.errors.join('\n')}`);
  const { items, references } = referenceInputs(loaded.questions);
  const built = buildOriginalModuleArtifacts(items, references);
  const expected = new Map<string, string>();
  for (const [file, value] of built.files) expected.set(file, `${JSON.stringify(value, null, 2)}\n`);
  expected.set(ORIGINAL_SOURCES, `${JSON.stringify(built.sources, null, 2)}\n`);
  expected.set(ORIGINAL_RELEASE, `${JSON.stringify({ schemaVersion: 1, questionIds: built.release.questionIds, questionSources: built.release.questionSources, questionFingerprints: servingFingerprints(built.files), questionSourceFingerprints: Object.fromEntries(Object.entries(built.release.questionSources).map(([id, sourceId]) => [id, moduleSourceFingerprint(sourceId, built.sources.sources[sourceId])])) }, null, 2)}\n`);
  expected.set(ORIGINAL_MANIFEST, `${JSON.stringify(originalQuestionManifest(loaded.questions.map((question) => question.originalId)), null, 2)}\n`);
  const differs = (file: string, body: string) => !existsSync(join(repoRoot, file)) || readFileSync(join(repoRoot, file), 'utf8') !== body;
  const changed = [...expected].filter(([file, body]) => differs(file, body)).map(([file]) => file);
  const stale = walk(join(repoRoot, ORIGINAL_MODULES)).map((file) => relative(repoRoot, file)).filter((file) => !expected.has(file));
  if (write) {
    for (const [file, body] of expected) { if (differs(file, body)) { mkdirSync(dirname(join(repoRoot, file)), { recursive: true }); writeFileSync(join(repoRoot, file), body); } }
    for (const file of stale) rmSync(join(repoRoot, file));
  }
  return { changed, stale, count: loaded.questions.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inputAt = process.argv.indexOf('--root');
  const root = inputAt >= 0 && process.argv[inputAt + 1] ? resolve(process.argv[inputAt + 1]) : DEFAULT_COHORT_ORIGINAL_QUESTION_ROOT;
  const check = checkOriginalQuestions(root);
  if (!check.ok) { console.error(check.errors.join('\n')); process.exitCode = 1; }
  else if (process.argv.includes('--write') || process.argv.includes('--check')) {
    const result = syncOriginalQuestions(root, process.argv.includes('--write'));
    if (process.argv.includes('--check') && (result.changed.length || result.stale.length)) { console.error(`original question artifacts out of date: ${result.changed.length + result.stale.length}`); process.exitCode = 1; }
    else console.log(`original question artifacts ${process.argv.includes('--write') ? 'written' : 'up to date'}: ${result.count} questions`);
  } else if (process.argv.includes('--json')) console.log(JSON.stringify(check, null, 2));
  else console.log(`Cohort original questions — ${check.questions} reviewed question(s), ${check.files} draft file(s)`);
}
