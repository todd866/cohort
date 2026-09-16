import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadOpenUsmleQuestionBankFromDisk,
  loadSeedQuestionBanksFromDisk,
} from './load-seed-corpus';
import { loadQuestionBankFromDisk } from './load';
import {
  computeOpenUsmleQuoteSetSha256,
  computeOpenUsmleRegistrySha256,
} from '@/lib/usmle/open-source-registry';
import { buildPublicUsmleReleaseFingerprints } from '@/lib/usmle/public-serving-drift';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function question(id: string, options: { open?: boolean; sourceId?: string } = {}) {
  const value: Record<string, unknown> = {
    id,
    rotation: options.open ? 'usmle-step1' : 'critical-care',
    topics: ['test objective'],
    questionType: 'mechanism',
    difficulty: 'easy',
    stem: 'Which mechanism best explains this test presentation?',
    options: [
      { label: 'A', text: 'Correct mechanism', isCorrect: true },
      { label: 'B', text: 'First distractor', isCorrect: false },
      { label: 'C', text: 'Second distractor', isCorrect: false },
      { label: 'D', text: 'Third distractor', isCorrect: false },
    ],
    context: 'Learning objective: test the loader contract.',
  };
  if (options.open) {
    value.moduleNodes = ['usmle/step1', 'usmle/step1/test'];
    value.publicUsmle = {
      schemaVersion: 1,
      origin: 'generated',
      itemText: { licence: 'CC-BY-4.0', attribution: 'MD3 contributors' },
      evidence: {
        kind: 'passage',
        sourceId: options.sourceId ?? 'source-1',
        passageId: 'passage-1',
        licence: { cls: 'foss', id: 'us-gov' },
      },
    };
  }
  return value;
}

function writePrivateBank(root: string, id = 'bank:critical-care:private:v1'): void {
  const dir = path.join(root, 'critical-care');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'private.json'), JSON.stringify(question(id)));
}

function writeOpenBank(
  root: string,
  id = 'bank:usmle-step1:open:v1',
  sourceId = 'source-1',
): {
  questionsDir: string;
  registryPath: string;
  baselineManifestPath: string;
  releaseManifestPath: string;
  questionPath: string;
} {
  const questionsDir = path.join(root, 'questions');
  const domainDir = path.join(questionsDir, 'test-domain');
  fs.mkdirSync(domainDir, { recursive: true });
  const questionPath = path.join(domainDir, 'open.v1.json');
  fs.writeFileSync(
    questionPath,
    JSON.stringify(question(id, { open: true, sourceId })),
  );
  const registryPath = path.join(root, 'sources.json');
  const source = {
    id: 'source-1',
    title: 'Public source',
    publisher: 'US agency',
    canonicalUrl: 'https://example.gov/source',
    attribution: 'Source: US agency',
    licence: {
      cls: 'foss' as const,
      id: 'us-gov',
      url: 'https://example.gov/copyright',
    },
    passages: [{ id: 'passage-1', locator: 'Section one', quote: 'Open passage.' }],
  };
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: 1,
    verifiedAt: '2026-08-01',
    quoteSetSha256: computeOpenUsmleQuoteSetSha256([source]),
    registrySha256: computeOpenUsmleRegistrySha256('2026-08-01', [source]),
    sources: [source],
  }));
  const baselineManifestPath = path.join(root, 'baseline-v1.json');
  fs.writeFileSync(baselineManifestPath, JSON.stringify({
    schemaVersion: 1,
    questionIds: [id],
  }));
  const releaseManifestPath = path.join(root, 'release-v1.json');
  const loaded = loadQuestionBankFromDisk({
    bankDir: questionsDir,
    allowUnregisteredRootDirs: true,
  });
  if (loaded.errors.length > 0) throw new Error(loaded.errors.join('\n'));
  fs.writeFileSync(releaseManifestPath, JSON.stringify({
    schemaVersion: 2,
    questionIds: [id],
    questionFingerprints: buildPublicUsmleReleaseFingerprints(loaded.questions, {
      baselineQuestionIds: new Set([id]),
    }),
  }));
  return {
    questionsDir,
    registryPath,
    baselineManifestPath,
    releaseManifestPath,
    questionPath,
  };
}

describe('loadOpenUsmleQuestionBankFromDisk', () => {
  it('loads the repo-native open bank without consulting a private sibling bank', () => {
    const root = tempDir('md3-open-bank-');
    const paths = writeOpenBank(root);

    const result = loadOpenUsmleQuestionBankFromDisk({
      bankDir: paths.questionsDir,
      sourceRegistryPath: paths.registryPath,
      baselineManifestPath: paths.baselineManifestPath,
      releaseManifestPath: paths.releaseManifestPath,
    });

    expect(result.errors).toEqual([]);
    expect(result.questions.map((item) => item.id)).toEqual(['bank:usmle-step1:open:v1']);
    expect(result.questions[0]?.moduleNodes).toContain('usmle/step1/baseline/v1');
  });

  it('fails closed when a generated evidence pointer is absent from the registry', () => {
    const root = tempDir('md3-open-source-missing-');
    const paths = writeOpenBank(root, 'bank:usmle-step1:bad-source:v1', 'unknown-source');

    const result = loadOpenUsmleQuestionBankFromDisk({
      bankDir: paths.questionsDir,
      sourceRegistryPath: paths.registryPath,
      baselineManifestPath: paths.baselineManifestPath,
      releaseManifestPath: paths.releaseManifestPath,
    });

    expect(result.questions).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/unknown source unknown-source/i);
  });

  it('rejects a baseline member that is absent from the open bank', () => {
    const root = tempDir('md3-open-baseline-missing-');
    const paths = writeOpenBank(root);
    fs.writeFileSync(paths.baselineManifestPath, JSON.stringify({
      schemaVersion: 1,
      questionIds: ['bank:usmle-step1:not-on-disk:v1'],
    }));

    const result = loadOpenUsmleQuestionBankFromDisk({
      bankDir: paths.questionsDir,
      sourceRegistryPath: paths.registryPath,
      baselineManifestPath: paths.baselineManifestPath,
      releaseManifestPath: paths.releaseManifestPath,
    });

    expect(result.questions).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/unknown baseline.*not-on-disk/i);
  });

  it('rejects both missing and implicitly-added release members', () => {
    const root = tempDir('md3-open-release-drift-');
    const paths = writeOpenBank(root);
    fs.writeFileSync(paths.releaseManifestPath, JSON.stringify({
      schemaVersion: 2,
      questionIds: ['bank:usmle-step1:not-on-disk:v1'],
      questionFingerprints: {
        'bank:usmle-step1:not-on-disk:v1': 'a'.repeat(64),
      },
    }));

    const result = loadOpenUsmleQuestionBankFromDisk({
      bankDir: paths.questionsDir,
      sourceRegistryPath: paths.registryPath,
      baselineManifestPath: paths.baselineManifestPath,
      releaseManifestPath: paths.releaseManifestPath,
    });

    expect(result.questions).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/unknown release question.*not-on-disk/i);
    expect(result.errors.join('\n')).toMatch(/unreleased source question.*open:v1/i);
  });

  it('rejects a source edit until the gated release fingerprint is refreshed', () => {
    const root = tempDir('md3-open-fingerprint-drift-');
    const paths = writeOpenBank(root);
    const edited = JSON.parse(fs.readFileSync(paths.questionPath, 'utf8')) as Record<string, unknown>;
    edited.context = 'Changed after the release fingerprint was recorded.';
    fs.writeFileSync(paths.questionPath, JSON.stringify(edited));

    const result = loadOpenUsmleQuestionBankFromDisk({
      bankDir: paths.questionsDir,
      sourceRegistryPath: paths.registryPath,
      baselineManifestPath: paths.baselineManifestPath,
      releaseManifestPath: paths.releaseManifestPath,
    });

    expect(result.questions).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/release fingerprint differs from source/i);
  });
});

describe('loadSeedQuestionBanksFromDisk', () => {
  it('combines private and open roots only after both validate', () => {
    const privateRoot = tempDir('md3-private-bank-');
    const openRoot = tempDir('md3-open-combined-');
    writePrivateBank(privateRoot);
    const openPaths = writeOpenBank(openRoot);

    const result = loadSeedQuestionBanksFromDisk({
      privateBankDir: privateRoot,
      openBankDir: openPaths.questionsDir,
      sourceRegistryPath: openPaths.registryPath,
      baselineManifestPath: openPaths.baselineManifestPath,
      releaseManifestPath: openPaths.releaseManifestPath,
    });

    expect(result.errors).toEqual([]);
    expect(result.questions.map((item) => item.id).sort()).toEqual([
      'bank:critical-care:private:v1',
      'bank:usmle-step1:open:v1',
    ]);
  });

  it('rejects duplicate IDs across roots instead of choosing one silently', () => {
    const privateRoot = tempDir('md3-private-duplicate-');
    const openRoot = tempDir('md3-open-duplicate-');
    const duplicateId = 'bank:usmle-step1:duplicate:v1';
    writePrivateBank(privateRoot, duplicateId);
    const openPaths = writeOpenBank(openRoot, duplicateId);

    const result = loadSeedQuestionBanksFromDisk({
      privateBankDir: privateRoot,
      openBankDir: openPaths.questionsDir,
      sourceRegistryPath: openPaths.registryPath,
      baselineManifestPath: openPaths.baselineManifestPath,
      releaseManifestPath: openPaths.releaseManifestPath,
    });

    expect(result.questions).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/duplicate question id.*across.*roots/i);
  });
});
