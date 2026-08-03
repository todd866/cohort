import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadQuestionBankFromDisk } from './load';

function makeQuestion(id: string, rotation: string) {
  return {
    id,
    rotation,
    week: 1,
    topics: ['test'],
    questionType: 'management',
    difficulty: 'easy',
    stem: 'Test stem for this question?',
    options: [
      { label: 'A', text: 'Correct answer', isCorrect: true },
      { label: 'B', text: 'Wrong answer one', isCorrect: false },
      { label: 'C', text: 'Wrong answer two', isCorrect: false },
      { label: 'D', text: 'Wrong answer three', isCorrect: false },
    ],
    context: 'Test explanation.',
  };
}

describe('loadQuestionBankFromDisk', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-test-'));
    const rotDir = path.join(tmpDir, 'critical-care');
    fs.mkdirSync(rotDir, { recursive: true });

    // Single-object file (legacy format)
    fs.writeFileSync(
      path.join(rotDir, 'single.json'),
      JSON.stringify({
        ...makeQuestion('bank:critical-care:single:v1', 'critical-care'),
        moduleNodes: ['critical-care', 'usmle/step1'],
        publicUsmle: {
          schemaVersion: 1,
          origin: 'authored',
          itemText: { licence: 'CC-BY-4.0', attribution: 'Ian Todd / md3' },
          evidence: { kind: 'none' },
        },
      }, null, 2)
    );

    // Array file (new format)
    fs.writeFileSync(
      path.join(rotDir, 'topic-a.json'),
      JSON.stringify([
        makeQuestion('bank:critical-care:arr-one:v1', 'critical-care'),
        makeQuestion('bank:critical-care:arr-two:v1', 'critical-care'),
      ], null, 2)
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads single-object JSON files', () => {
    const result = loadQuestionBankFromDisk({ bankDir: tmpDir });
    const ids = result.questions.map((q) => q.id);
    expect(ids).toContain('bank:critical-care:single:v1');
    expect(result.errors).toEqual([]);
  });

  it('loads array JSON files', () => {
    const result = loadQuestionBankFromDisk({ bankDir: tmpDir });
    const ids = result.questions.map((q) => q.id);
    expect(ids).toContain('bank:critical-care:arr-one:v1');
    expect(ids).toContain('bank:critical-care:arr-two:v1');
    expect(result.errors).toEqual([]);
  });

  it('loads all 3 questions from both formats', () => {
    const result = loadQuestionBankFromDisk({ bankDir: tmpDir });
    expect(result.questions).toHaveLength(3);
  });

  it('sets sourceFile on array-loaded questions', () => {
    const result = loadQuestionBankFromDisk({ bankDir: tmpDir });
    const arrQ = result.questions.find((q) => q.id === 'bank:critical-care:arr-one:v1');
    expect(arrQ?.sourceFile).toMatch(/topic-a\.json$/);
  });

  it('retains validated public USMLE provenance for seeding', () => {
    const result = loadQuestionBankFromDisk({ bankDir: tmpDir });
    const question = result.questions.find((q) => q.id === 'bank:critical-care:single:v1');
    expect(question?.publicUsmle).toEqual({
      schemaVersion: 1,
      origin: 'authored',
      itemText: { licence: 'CC-BY-4.0', attribution: 'Ian Todd / md3' },
      evidence: { kind: 'none' },
    });
  });

  it('retains validated moduleNodes for public-corpus projection', () => {
    const result = loadQuestionBankFromDisk({ bankDir: tmpDir });
    const question = result.questions.find((q) => q.id === 'bank:critical-care:single:v1');
    expect(question?.moduleNodes).toEqual(['critical-care', 'usmle/step1']);
  });

  it('rejects malformed public provenance instead of passing it through', () => {
    const invalidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-public-provenance-'));
    try {
      const rotDir = path.join(invalidDir, 'critical-care');
      fs.mkdirSync(rotDir, { recursive: true });
      fs.writeFileSync(
        path.join(rotDir, 'invalid.json'),
        JSON.stringify({
          ...makeQuestion('bank:critical-care:invalid-public:v1', 'critical-care'),
          publicUsmle: {
            schemaVersion: 1,
            origin: 'generated',
            itemText: { licence: 'CC-BY-4.0', attribution: 'Ian Todd / md3' },
            evidence: { kind: 'passage', sourceId: '', passageId: '' },
          },
        }),
      );

      const result = loadQuestionBankFromDisk({ bankDir: invalidDir });
      expect(result.questions).toEqual([]);
      expect(result.errors.join('\n')).toMatch(/publicUsmle|sourceId|passageId/i);
    } finally {
      fs.rmSync(invalidDir, { recursive: true, force: true });
    }
  });
});

describe('loadQuestionBankFromDisk — domain-root release corpus', () => {
  it('loads nested domain directories only when explicitly allowed', () => {
    const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-open-release-'));
    try {
      const domainDir = path.join(releaseDir, 'cardiovascular');
      fs.mkdirSync(domainDir, { recursive: true });
      fs.writeFileSync(
        path.join(domainDir, 'original.v1.json'),
        JSON.stringify({
          ...makeQuestion('bank:usmle-step1:cardiovascular-original:v1', 'usmle-step1'),
          moduleNodes: ['usmle/step1'],
        }),
      );

      const privateSemantics = loadQuestionBankFromDisk({ bankDir: releaseDir });
      expect(privateSemantics.questions).toEqual([]);

      const releaseSemantics = loadQuestionBankFromDisk({
        bankDir: releaseDir,
        allowUnregisteredRootDirs: true,
      });
      expect(releaseSemantics.errors).toEqual([]);
      expect(releaseSemantics.questions).toEqual([
        expect.objectContaining({
          id: 'bank:usmle-step1:cardiovascular-original:v1',
          moduleNodes: ['usmle/step1'],
        }),
      ]);
    } finally {
      fs.rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed moduleNodes rather than silently dropping membership', () => {
    const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-open-membership-'));
    try {
      fs.writeFileSync(
        path.join(releaseDir, 'invalid.json'),
        JSON.stringify({
          ...makeQuestion('bank:usmle-step1:invalid-membership:v1', 'usmle-step1'),
          moduleNodes: 'usmle/step1',
        }),
      );

      const result = loadQuestionBankFromDisk({
        bankDir: releaseDir,
        allowUnregisteredRootDirs: true,
      });
      expect(result.questions).toEqual([]);
      expect(result.errors.join('\n')).toMatch(/moduleNodes/i);
    } finally {
      fs.rmSync(releaseDir, { recursive: true, force: true });
    }
  });

});

describe('loadQuestionBankFromDisk — missing-dir safety', () => {
  it('returns a sentinel error (not silent-empty) when bankDir does not exist', () => {
    // The 2026-06-11 incident: an unresolved `question-bank` symlink in a worktree
    // returned empty-with-no-errors, so the seed retired the entire bank. A missing
    // dir must surface an error so the seed's errors.length gate aborts.
    const result = loadQuestionBankFromDisk({ bankDir: '/nonexistent/question-bank-path-xyz' });
    expect(result.questions).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/not found|refusing/i);
  });
});
