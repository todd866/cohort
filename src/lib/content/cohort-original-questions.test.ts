import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadCohortOriginalQuestionsFromDisk,
  mergeOriginalQuestions,
  originalQuestionContentHash,
  originalQuestionManifest,
  parseOriginalQuestionManifest,
  reconcileOriginalQuestions,
} from './cohort-original-questions';

const roots: string[] = [];
const makeRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'md3-original-questions-')); roots.push(root); mkdirSync(path.join(root, 'anatomy'), { recursive: true }); return root; };
const item = (over: Record<string, unknown> = {}) => {
  const base = {
    originalId: 'abducens-function', stem: 'Which action is primarily performed by the abducens nerve?',
    options: [
      { label: 'A', text: 'Abducts the eye', isCorrect: true, explanation: 'It supplies lateral rectus.' },
      { label: 'B', text: 'Adducts the eye', isCorrect: false, explanation: 'Medial rectus performs adduction.' },
      { label: 'C', text: 'Elevates the eye', isCorrect: false, explanation: 'Elevation is supplied by other muscles.' },
    ],
    context: 'The nerve is cranial nerve VI.', topics: ['cranial nerves'], difficulty: 'easy', questionType: 'single-best-answer',
    sources: [{ title: 'NCBI Abducens Nerve', url: 'https://www.ncbi.nlm.nih.gov/books/NBK537070/' }],
  };
  const merged = { ...base, ...over };
  return { ...merged, review: { status: 'accepted', contentHash: originalQuestionContentHash(merged as Parameters<typeof originalQuestionContentHash>[0]), reviewer: 'anatomy-reviewer', reviewedAt: '2026-10-06' } };
};
const writeDeck = (root: string, value: unknown = {}, name = 'exam-questions-draft.json') => writeFileSync(path.join(root, 'anatomy', name), JSON.stringify({ schemaVersion: 1, licence: 'CC-BY-4.0', attribution: 'MD3 contributors', discipline: 'anatomy', items: [item(value as Record<string, unknown>)] }));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('cohort original question lane', () => {
  it('loads a reviewed question with stable public identity and reference', () => {
    const root = makeRoot(); writeDeck(root);
    const result = loadCohortOriginalQuestionsFromDisk({ root });
    expect(result.errors).toEqual([]); expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({ originalId: 'abducens-function', sourceFile: 'open-content/modules/original-question-sources/anatomy/exam-questions-draft.json', question: { id: expect.stringMatching(/^cohort:anatomy:q-[0-9a-f]{12}:v1$/), origin: expect.stringMatching(/^md3:[0-9a-f]{16}$/), reference: { title: 'NCBI Abducens Nerve' } } });
  });
  it('fails closed for stale review, duplicate keys, and unknown fields', () => {
    const root = makeRoot(); writeDeck(root, { extra: 'reject' });
    const raw = JSON.parse(readFileSync(path.join(root, 'anatomy/exam-questions-draft.json'), 'utf8')); raw.items[0].review.contentHash = '0'.repeat(64); writeFileSync(path.join(root, 'anatomy/exam-questions-draft.json'), JSON.stringify(raw));
    const result = loadCohortOriginalQuestionsFromDisk({ root }); expect(result.questions).toEqual([]); expect(result.errors.join('\n')).toMatch(/unexpected field extra|does not match authored content/);
  });
  it('requires exactly one key and complete option explanations', () => {
    const root = makeRoot(); writeDeck(root, { options: [{ label: 'A', text: 'one', isCorrect: true, explanation: '' }, { label: 'B', text: 'two', isCorrect: true, explanation: 'x' }] });
    const result = loadCohortOriginalQuestionsFromDisk({ root }); expect(result.questions).toEqual([]); expect(result.errors.join('\n')).toMatch(/exactly one correct|explanation/);
  });
  it('binds a reference-only source to the clinical review hash', () => {
    const root = makeRoot(); writeDeck(root);
    const file = path.join(root, 'anatomy/exam-questions-draft.json'); const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.items[0].reference = raw.items[0].sources[0]; delete raw.items[0].sources;
    const authored = { ...raw.items[0], sources: [raw.items[0].reference] }; delete authored.review;
    raw.items[0].review.contentHash = originalQuestionContentHash(authored);
    writeFileSync(file, JSON.stringify(raw)); expect(loadCohortOriginalQuestionsFromDisk({ root }).errors).toEqual([]);
    raw.items[0].reference.url = 'https://example.org/changed'; writeFileSync(file, JSON.stringify(raw));
    expect(loadCohortOriginalQuestionsFromDisk({ root }).errors.join('\n')).toContain('does not match authored content');
  });
  it('manifest detects duplicate or withdrawn authored ids', () => {
    const parsed = parseOriginalQuestionManifest(originalQuestionManifest(['abducens-function']), new Set(['abducens-function'])); expect(parsed.errors).toEqual([]);
    expect(parseOriginalQuestionManifest({ schemaVersion: 1, originalIds: ['abducens-function', 'abducens-function'] }, new Set(['abducens-function'])).errors).toContain('manifest: duplicate originalIds');
    expect(parseOriginalQuestionManifest({ schemaVersion: 1, originalIds: ['withdrawn'] }, new Set(['abducens-function'])).errors.join('\n')).toContain('absent from existing release');
  });
  it('reconciles only the original lane and preserves private rows', () => {
    const root = makeRoot(); writeDeck(root); const loaded = loadCohortOriginalQuestionsFromDisk({ root }).questions[0];
    const privateRow = { ...loaded.question, id: 'private:anatomy:q-private:v1', origin: 'md3:private-origin' };
    expect(reconcileOriginalQuestions([loaded.question, privateRow], ['abducens-function'], [])).toEqual([privateRow]);
    expect(mergeOriginalQuestions([privateRow], [loaded.question])).toHaveLength(2);
    expect(() => mergeOriginalQuestions([loaded.question], [loaded.question])).toThrow(/duplicate original/);
    expect(() => mergeOriginalQuestions([], [loaded.question, loaded.question])).toThrow(/duplicate original/);
  });
});
