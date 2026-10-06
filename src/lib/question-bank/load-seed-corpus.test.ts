import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadCohortModuleQuestionBankFromDisk,
  loadOpenUsmleQuestionBankFromDisk,
  loadSeedQuestionBanksFromDisk,
} from './load-seed-corpus';
import { buildModuleArtifacts, buildOriginalModuleArtifacts, moduleReleaseFingerprints } from '@/lib/content/cohort-module-corpus';
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

const mirrored = {
  id: 'open:paeds:q-0123456789ab:v1',
  origin: 'md3:0123456789abcdef',
  discipline: 'paeds' as const,
  stem: 'A febrile 6-week-old has no focus on examination. What is the next step?',
  options: [
    { label: 'A', text: 'Full septic workup', isCorrect: true, explanation: 'Under 3 months.' },
    { label: 'B', text: 'Oral antibiotics and review', isCorrect: false, explanation: 'Too young.' },
    { label: 'C', text: 'Paracetamol and discharge', isCorrect: false, explanation: 'Unsafe without a screen.' },
    { label: 'D', text: 'Urine dipstick only', isCorrect: false, explanation: 'Misses meningitis and bacteraemia.' },
  ],
  context: 'Febrile infants under 3 months need a full septic screen.',
  topics: ['fever'],
  difficulty: 'medium',
  questionType: 'next-step',
  reference: { title: 'Febrile child', url: 'https://www.rch.org.au/x', publisher: 'RCH' },
  licence: 'CC-BY-4.0' as const,
  attribution: 'MD3 contributors' as const,
};
const original = { ...mirrored, id: 'cohort:anatomy:q-abcdefabcdef:v1', origin: 'md3:abcdefabcdefabcdef', discipline: 'anatomy' as const, originalId: 'abducens-function' };

/** A module root exactly as `content:cohort-mirror-questions --write` lays it out. */
function writeModuleBank(root: string, question = mirrored): { root: string; questionPath: string } {
  const built = buildModuleArtifacts([{ question, sourceId: 'rch-fever' }], {
    'rch-fever': { title: 'Febrile child', publisher: 'RCH', url: 'https://www.rch.org.au/x', verifiedAt: '2026-09-23' },
  });
  let questionPath = '';
  for (const [rel, file] of built.files) {
    questionPath = path.join(root, rel.replace(/^open-content\/modules\//, ''));
    fs.mkdirSync(path.dirname(questionPath), { recursive: true });
    fs.writeFileSync(questionPath, JSON.stringify(file));
  }
  fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify(built.sources));
  // Fingerprints come from what the loader will actually seed, exactly as the generator does it.
  const loaded = loadQuestionBankFromDisk({ bankDir: path.join(root, 'questions'), allowUnregisteredRootDirs: true });
  if (loaded.errors.length > 0) throw new Error(loaded.errors.join('\n'));
  fs.writeFileSync(path.join(root, 'release-v1.json'), JSON.stringify({
    ...built.release,
    questionFingerprints: moduleReleaseFingerprints(loaded.questions),
  }));
  return { root, questionPath };
}

function writeOriginalModuleBank(root: string): void {
  const built = buildOriginalModuleArtifacts([{ question: original, sourceId: 'anatomy-source', originalId: 'abducens-function' }], {
    'anatomy-source': { title: 'Anatomy source', publisher: 'NCBI', url: 'https://example.org/anatomy', verifiedAt: '2026-10-06' },
  });
  for (const [rel, file] of built.files) {
    const target = path.join(root, rel.replace(/^open-content\/modules\//, ''));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(file));
  }
  fs.writeFileSync(path.join(root, 'original-questions-sources.json'), JSON.stringify(built.sources));
  const loaded = loadQuestionBankFromDisk({ bankDir: path.join(root, 'original-questions'), allowUnregisteredRootDirs: true });
  if (loaded.errors.length > 0) throw new Error(loaded.errors.join('\n'));
  const fingerprints = moduleReleaseFingerprints(loaded.questions.map((question) => ({
    ...question,
    sourceFile: `open-content/modules/original-questions/${question.moduleNodes?.[0]?.split('/').pop() ?? 'anatomy'}/${path.basename(question.sourceFile ?? '')}`,
  })));
  fs.writeFileSync(path.join(root, 'original-questions-release-v1.json'), JSON.stringify({ ...built.release, questionFingerprints: fingerprints }));
}

describe('loadCohortModuleQuestionBankFromDisk', () => {
  it('loads the generated module bank as its own cohort-open rows', () => {
    const { root } = writeModuleBank(tempDir('md3-module-bank-'));
    const result = loadCohortModuleQuestionBankFromDisk({ moduleRoot: root });
    expect(result.errors).toEqual([]);
    expect(result.questions.map((q) => [q.id, q.rotation, q.moduleNodes])).toEqual([
      ['bank:cohort:paeds:q-0123456789ab:v1', 'cohort-open', ['cohort/paeds']],
    ]);
  });

  it('loads accepted original questions from their separate release lane', () => {
    const root = tempDir('md3-original-module-bank-'); writeModuleBank(root); writeOriginalModuleBank(root);
    const result = loadCohortModuleQuestionBankFromDisk({ moduleRoot: root });
    expect(result.errors).toEqual([]);
    expect(result.questions.map((q) => q.id)).toEqual(['bank:cohort:paeds:q-0123456789ab:v1', 'bank:cohort:anatomy:q-abcdefabcdef:v1']);
  });

  it('refuses a file edited after its review', () => {
    const { root, questionPath } = writeModuleBank(tempDir('md3-module-stale-'));
    const file = JSON.parse(fs.readFileSync(questionPath, 'utf8'));
    fs.writeFileSync(questionPath, JSON.stringify({ ...file, stem: `${file.stem} Edited.` }));
    const result = loadCohortModuleQuestionBankFromDisk({ moduleRoot: root });
    expect(result.questions).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/review-stale/);
  });

  it('refuses a question the release list does not name, and a listed one that is missing', () => {
    const { root } = writeModuleBank(tempDir('md3-module-release-'));
    fs.writeFileSync(path.join(root, 'release-v1.json'), JSON.stringify({ schemaVersion: 1, questionIds: ['bank:cohort:paeds:q-ffffffffffff:v1'], questionFingerprints: {}, questionSources: {} }));
    const result = loadCohortModuleQuestionBankFromDisk({ moduleRoot: root });
    expect(result.questions).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/q-0123456789ab.*not in the release/);
    expect(result.errors.join('\n')).toMatch(/q-ffffffffffff.*missing/);
  });

  it('refuses a release whose serving fingerprint no longer matches the file it names', () => {
    const { root } = writeModuleBank(tempDir('md3-module-fingerprint-'));
    const releasePath = path.join(root, 'release-v1.json');
    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    const [id] = release.questionIds;
    release.questionFingerprints[id] = '0'.repeat(64);
    fs.writeFileSync(releasePath, JSON.stringify(release));
    const result = loadCohortModuleQuestionBankFromDisk({ moduleRoot: root });
    expect(result.questions).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/fingerprint/);
  });

  it('refuses a release that names a different source than the file cites', () => {
    const { root } = writeModuleBank(tempDir('md3-module-source-'));
    const releasePath = path.join(root, 'release-v1.json');
    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    const [id] = release.questionIds;
    release.questionSources[id] = 'some-other-source';
    fs.writeFileSync(releasePath, JSON.stringify(release));
    const result = loadCohortModuleQuestionBankFromDisk({ moduleRoot: root });
    expect(result.questions).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/source/);
  });

  it('treats a missing module root as an error, never as an empty bank', () => {
    const result = loadCohortModuleQuestionBankFromDisk({ moduleRoot: path.join(tempDir('md3-module-none-'), 'absent') });
    expect(result.questions).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('loadSeedQuestionBanksFromDisk', () => {
  it('combines private and open roots only after both validate', () => {
    const privateRoot = tempDir('md3-private-bank-');
    const openRoot = tempDir('md3-open-combined-');
    writePrivateBank(privateRoot);
    const openPaths = writeOpenBank(openRoot);

    const moduleBank = writeModuleBank(tempDir('md3-module-combined-'));

    const result = loadSeedQuestionBanksFromDisk({
      privateBankDir: privateRoot,
      openBankDir: openPaths.questionsDir,
      sourceRegistryPath: openPaths.registryPath,
      baselineManifestPath: openPaths.baselineManifestPath,
      releaseManifestPath: openPaths.releaseManifestPath,
      moduleRoot: moduleBank.root,
    });

    expect(result.errors).toEqual([]);
    // The module root must be in the full seed's corpus, or its stale sweep retires every mirrored row.
    expect(result.questions.map((item) => item.id).sort()).toEqual([
      'bank:cohort:paeds:q-0123456789ab:v1',
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
      moduleRoot: writeModuleBank(tempDir('md3-module-duplicate-')).root,
    });

    expect(result.questions).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/duplicate question id.*across.*roots/i);
  });
});
