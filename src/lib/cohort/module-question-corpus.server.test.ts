import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
const step1 = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/usmle/public-question-corpus.server', () => ({ loadPublicUsmleQuestionCorpus: step1.load }));

import checkedInRelease from '../../../open-content/modules/release-v1.json';
import checkedInSources from '../../../open-content/modules/sources.json';
import originalRelease from '../../../open-content/modules/original-questions-release-v1.json';
import originalSources from '../../../open-content/modules/original-questions-sources.json';
import { loadCohortModuleQuestionBankFromDisk } from '@/lib/question-bank/load-seed-corpus';
import { expectedPublicUsmleStoredQuestion } from '@/lib/usmle/public-serving-drift';
import { publicUsmleServingFingerprint } from '@/lib/usmle/public-serving-fingerprint';
import type { PublicUsmleStoredQuestion } from '@/lib/usmle/public-serving-fingerprint';
import {
  buildCohortModuleCorpus,
  loadCohortServableCorpus,
  type CohortModuleServingRelease,
} from './module-question-corpus.server';
import type { CohortModuleSourceRegistry } from '@/lib/content/cohort-module-corpus';

const release: CohortModuleServingRelease = { ...checkedInRelease, schemaVersion: 1,
  questionIds: [...checkedInRelease.questionIds, ...originalRelease.questionIds],
  questionSources: { ...checkedInRelease.questionSources, ...originalRelease.questionSources },
  questionFingerprints: { ...checkedInRelease.questionFingerprints, ...originalRelease.questionFingerprints },
  questionSourceFingerprints: originalRelease.questionSourceFingerprints,
};
const registry: CohortModuleSourceRegistry = { schemaVersion: 1, sources: { ...checkedInSources.sources, ...originalSources.sources } } as CohortModuleSourceRegistry;

/** Every checked-in module file, exactly as the seed stores it. */
function seededRows(): PublicUsmleStoredQuestion[] {
  const loaded = loadCohortModuleQuestionBankFromDisk();
  if (loaded.errors.length > 0) throw new Error(loaded.errors.join('\n'));
  return loaded.questions.map((question) => expectedPublicUsmleStoredQuestion(question));
}

describe('buildCohortModuleCorpus', () => {
  it('serves every released module question, seeded exactly from its checked-in file', () => {
    const corpus = buildCohortModuleCorpus(seededRows(), release, registry);
    expect(corpus.questions.map((q) => q.id).sort()).toEqual([...release.questionIds].sort());
    expect(corpus.decisions.every((d) => d.decision.eligible)).toBe(true);
  });

  it('cites the guideline as an unquoted reference and never exposes private row fields', () => {
    const [question] = buildCohortModuleCorpus(seededRows(), release, registry).questions;
    expect(question.renderEvidenceQuote).toBe(false);
    expect(question.publicProvenance.evidence).toMatchObject({ kind: 'reference', licence: { cls: 'verify' } });
    expect(question.resolvedCitation).toMatchObject({ kind: 'reference', passageLocator: null });
    expect(question.resolvedCitation?.quote).toBeUndefined();
    expect(question.resolvedCitation?.canonicalUrl).toMatch(/^https:\/\//);
    for (const field of ['source', 'sourceFile', 'contentState', 'excluded', 'citations', 'annotations']) {
      expect(question).not.toHaveProperty(field);
    }
  });

  it('refuses a row whose content drifted from its released fingerprint', () => {
    const [row, ...rest] = seededRows();
    const corpus = buildCohortModuleCorpus([{ ...row, stem: `${row.stem} (edited in the database)` }, ...rest], release, registry);
    expect(corpus.questions.map((q) => q.id)).not.toContain(row.id);
    expect(corpus.decisions.find((d) => d.questionId === row.id)?.decision).toMatchObject({
      eligible: false, reason: 'release-content-drift',
    });
  });

  it('refuses a row outside the release, off the cohort-open rotation, or no longer servable', () => {
    const [row] = seededRows();
    const stranger = { ...row, id: 'bank:cohort:paeds:q-ffffffffffff:v1' };
    const privateRotation = { ...row, rotation: 'cah' };
    const retired = { ...row, contentState: 'retired' };
    for (const [candidate, reason] of [
      [stranger, 'not-release-manifest-member'],
      [privateRotation, 'not-cohort-module-row'],
      [retired, 'unservable-state'],
    ] as const) {
      const corpus = buildCohortModuleCorpus([candidate], release, registry);
      expect(corpus.questions).toEqual([]);
      expect(corpus.decisions[0].decision).toMatchObject({ eligible: false, reason });
    }
  });

  it('refuses a question whose cited source is not in the checked-in registry', () => {
    const [row] = seededRows();
    const corpus = buildCohortModuleCorpus([row], release, { schemaVersion: 1, sources: {} });
    expect(corpus.questions).toEqual([]);
    expect(corpus.decisions[0].decision).toMatchObject({ eligible: false, reason: 'evidence-source-not-registered' });
  });

  it('holds original content when reviewed citation metadata drifts or its binding is absent', () => {
    const row = seededRows().find((item) => item.sourceFile?.startsWith('open-content/modules/original-questions/'))!;
    expect(row).toBeDefined();
    for (const sourceFile of [null, 'open-content/modules/questions/anatomy/forged.json']) {
      expect(buildCohortModuleCorpus([{ ...row, sourceFile }], release, registry).decisions[0].decision).toMatchObject({ eligible: false, reason: 'release-content-drift' });
    }
    const sourceId = release.questionSources[row.id];
    for (const changes of [{ title: 'Unreviewed title' }, { url: 'https://example.org/unreviewed' }]) {
      const changed = { ...registry, sources: { ...registry.sources, [sourceId]: { ...registry.sources[sourceId], ...changes } } };
      expect(buildCohortModuleCorpus([row], release, changed).decisions[0].decision).toMatchObject({ eligible: false, reason: 'evidence-source-drift' });
    }
    expect(buildCohortModuleCorpus([row], { ...release, questionSourceFingerprints: {} }, registry).decisions[0].decision).toMatchObject({ eligible: false, reason: 'evidence-source-drift' });
  });

  it('serves an original-lane row when its separate release and source are supplied', () => {
    const row = { ...seededRows()[0], id: 'bank:cohort:anatomy:q-abcdefabcdef:v1', moduleNodes: ['cohort/anatomy'] };
    const originalRelease: CohortModuleServingRelease = {
      schemaVersion: 1, questionIds: [row.id], questionSources: { [row.id]: 'anatomy-source' },
      questionFingerprints: { [row.id]: publicUsmleServingFingerprint(row) },
    };
    const originalRegistry: CohortModuleSourceRegistry = { schemaVersion: 1, sources: {
      'anatomy-source': { title: 'Anatomy source', publisher: 'NCBI', url: 'https://example.org/anatomy', verifiedAt: '2026-10-06', licence: { cls: 'verify' } },
    } };
    const corpus = buildCohortModuleCorpus([row], originalRelease, originalRegistry);
    expect(corpus.questions).toHaveLength(1); expect(corpus.decisions[0].decision).toEqual({ eligible: true });
  });
});

describe('loadCohortServableCorpus', () => {
  const store = (rows: PublicUsmleStoredQuestion[]) => ({ question: { findMany: vi.fn(async () => rows) } }) as never;

  it('serves the Step 1 corpus and the released modules together', async () => {
    step1.load.mockResolvedValueOnce({ questions: [{ id: 'bank:usmle-step1:x:v1' }], decisions: [] });
    const corpus = await loadCohortServableCorpus(store(seededRows()));
    expect(corpus.questions).toHaveLength(1 + release.questionIds.length);
    expect(corpus.questions[0].id).toBe('bank:usmle-step1:x:v1');
  });

  it('refuses rather than silently shadowing when a module id collides with Step 1', async () => {
    const [row] = seededRows();
    step1.load.mockResolvedValueOnce({ questions: [{ id: row.id }], decisions: [] });
    await expect(loadCohortServableCorpus(store([row]))).rejects.toThrow(/collision/);
  });
});
