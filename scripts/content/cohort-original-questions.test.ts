import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { checkOriginalQuestions, syncOriginalQuestions } from './cohort-original-questions';
import { originalQuestionContentHash } from '../../src/lib/content/cohort-original-questions';
import { loadCohortModuleQuestionBankFromDisk } from '../../src/lib/question-bank/load-seed-corpus';
import { expectedPublicUsmleStoredQuestion } from '../../src/lib/usmle/public-serving-drift';
import { publicUsmleServingFingerprint } from '../../src/lib/usmle/public-serving-fingerprint';
import { buildCohortModuleCorpus } from '../../src/lib/cohort/module-question-corpus.server';

const roots: string[] = [];
const makeDraft = (valid = true) => {
  const root = mkdtempSync(path.join(tmpdir(), 'md3-original-question-script-')); roots.push(root); mkdirSync(path.join(root, 'anatomy'), { recursive: true });
  const item = { originalId: 'optic-nerve-function', stem: 'Which function is associated with the optic nerve?', options: [{ label: 'A', text: 'Vision', isCorrect: true, explanation: 'CN II carries visual information.' }, { label: 'B', text: 'Eye abduction', isCorrect: false, explanation: 'CN VI supplies lateral rectus.' }, { label: 'C', text: 'Facial expression', isCorrect: false, explanation: 'The facial nerve supplies muscles of facial expression.' }, { label: 'D', text: 'Tongue movement', isCorrect: false, explanation: 'The hypoglossal nerve supplies tongue movement.' }], context: 'The optic nerve carries visual information from the retina.', topics: ['cranial nerves'], difficulty: 'easy', questionType: 'single-best-answer', sources: [{ title: 'NCBI Optic Nerve', url: 'https://www.ncbi.nlm.nih.gov/books/NBK482259/' }] };
  const review = { status: 'accepted', contentHash: originalQuestionContentHash(item), reviewer: 'reviewer', reviewedAt: '2026-10-06' };
  if (!valid) review.contentHash = '0'.repeat(64);
  writeFileSync(path.join(root, 'anatomy/exam-questions-draft.json'), JSON.stringify({ schemaVersion: 1, licence: 'CC-BY-4.0', attribution: 'MD3 contributors', discipline: 'anatomy', items: [{ ...item, review }] }));
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('checkOriginalQuestions', () => {
  it('reports a valid reviewed draft without writing', () => { const root = makeDraft(); const result = checkOriginalQuestions(root); expect(result).toMatchObject({ files: 1, questions: 1, errors: [], ok: true }); });
  it('fails the gate when review content is stale', () => { const result = checkOriginalQuestions(makeDraft(false)); expect(result.ok).toBe(false); expect(result.errors.join('\n')).toContain('does not match authored content'); });
  it('writes only the original lane and retires stale originals', () => {
    const draft = makeDraft();
    const repo = mkdtempSync(path.join(tmpdir(), 'md3-original-question-repo-')); roots.push(repo);
    const mirror = path.join(repo, 'open-content/modules/questions/anatomy'); mkdirSync(mirror, { recursive: true });
    const mirrorFile = path.join(mirror, 'keep.json'); writeFileSync(mirrorFile, '{"keep":true}\n');
    const mirrorSources = path.join(repo, 'open-content/modules/sources.json'); mkdirSync(path.dirname(mirrorSources), { recursive: true }); writeFileSync(mirrorSources, '{"mirror":true}\n');
    const mirrorRelease = path.join(repo, 'open-content/modules/release-v1.json'); writeFileSync(mirrorRelease, '{"mirror":true}\n');
    const stale = path.join(repo, 'open-content/modules/original-questions/anatomy/stale.v1.json'); mkdirSync(path.dirname(stale), { recursive: true }); writeFileSync(stale, '{}');
    const result = syncOriginalQuestions(draft, true, repo);
    expect(result.count).toBe(1); expect(existsSync(stale)).toBe(false); expect(readFileSync(mirrorFile, 'utf8')).toBe('{"keep":true}\n');
    expect(readFileSync(mirrorSources, 'utf8')).toBe('{"mirror":true}\n'); expect(readFileSync(mirrorRelease, 'utf8')).toBe('{"mirror":true}\n');
    expect(existsSync(path.join(repo, 'open-content/modules/original-question-ids-v1.json'))).toBe(true);
    expect(existsSync(path.join(repo, 'open-content/modules/original-questions/anatomy'))).toBe(true);
  });
  it('round-trips generated originals into the runtime serving gate', () => {
    const draft = makeDraft(); const repo = mkdtempSync(path.join(tmpdir(), 'md3-original-question-e2e-')); roots.push(repo);
    syncOriginalQuestions(draft, true, repo);
    mkdirSync(path.join(repo, 'open-content/modules/questions'), { recursive: true });
    writeFileSync(path.join(repo, 'open-content/modules/sources.json'), JSON.stringify({ schemaVersion: 1, sources: {} }));
    writeFileSync(path.join(repo, 'open-content/modules/release-v1.json'), JSON.stringify({ schemaVersion: 1, questionIds: [], questionSources: {}, questionFingerprints: {} }));
    const moduleRoot = path.join(repo, 'open-content/modules');
    const loaded = loadCohortModuleQuestionBankFromDisk({ moduleRoot });
    expect(loaded.errors).toEqual([]); expect(loaded.questions).toHaveLength(1);
    const release = JSON.parse(readFileSync(path.join(moduleRoot, 'original-questions-release-v1.json'), 'utf8'));
    const registry = JSON.parse(readFileSync(path.join(moduleRoot, 'original-questions-sources.json'), 'utf8'));
    const seeded = { ...loaded.questions[0], sourceFile: 'open-content/modules/original-questions/anatomy/q-8de7239c5843.v1.json' };
    const corpus = buildCohortModuleCorpus([expectedPublicUsmleStoredQuestion(seeded)], release, registry);
    expect(corpus.questions.map((question) => question.id)).toEqual([loaded.questions[0].id]);
    expect(corpus.decisions[0].decision).toEqual({ eligible: true });
  });
});
