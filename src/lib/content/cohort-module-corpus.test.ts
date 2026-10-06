import { describe, expect, it } from 'vitest';
import {
  buildModuleArtifacts,
  buildOriginalModuleArtifacts,
  decidePublicModuleQuestion,
  moduleItemContentHash,
  type CohortModuleQuestionFile,
  type CohortModuleSourceRegistry,
} from './cohort-module-corpus';

const registry: CohortModuleSourceRegistry = {
  schemaVersion: 1,
  sources: {
    'rch-fever': {
      title: 'Febrile child',
      publisher: 'The Royal Children’s Hospital Melbourne',
      url: 'https://www.rch.org.au/clinicalguide/guideline_index/Febrile_child/',
      verifiedAt: '2026-09-23',
      licence: { cls: 'verify' },
    },
  },
};

function item(over: Partial<CohortModuleQuestionFile> = {}): CohortModuleQuestionFile {
  const base: CohortModuleQuestionFile = {
    id: 'bank:cohort:paeds:q-0123456789ab:v1',
    rotation: 'cohort-open',
    moduleNodes: ['cohort/paeds'],
    topics: ['fever'],
    questionType: null,
    difficulty: 'medium',
    stem: 'A febrile 6-week-old …',
    options: [
      { label: 'A', text: 'Full septic workup', isCorrect: true, explanation: 'Under 3 months.' },
      { label: 'B', text: 'Oral antibiotics and review', isCorrect: false, explanation: 'Too young.' },
    ],
    context: null,
    publicModule: {
      schemaVersion: 1,
      origin: 'mirrored',
      discipline: 'paeds',
      mirroredFrom: 'md3:0123456789abcdef',
      itemText: { licence: 'CC-BY-4.0', attribution: 'MD3 contributors' },
      evidence: { kind: 'reference', sourceId: 'rch-fever' },
      review: { verdict: 'passed', contentHash: '' },
    },
    ...over,
  };
  base.publicModule.review.contentHash = moduleItemContentHash(base);
  return base;
}

describe('decidePublicModuleQuestion', () => {
  it('serves a mirrored item with a verified guideline reference and a passed review of its exact wording', () => {
    expect(decidePublicModuleQuestion(item(), registry)).toEqual({ eligible: true });
  });

  it('refuses an item whose wording changed after its review', () => {
    const edited = item();
    edited.stem = 'A febrile 5-week-old …';
    expect(decidePublicModuleQuestion(edited, registry)).toMatchObject({ eligible: false, reason: 'review-stale' });
  });

  it('refuses an item whose review did not pass', () => {
    const failed = item();
    failed.publicModule.review.verdict = 'needs-fix';
    expect(decidePublicModuleQuestion(failed, registry)).toMatchObject({ eligible: false, reason: 'review-not-passed' });
  });

  it('refuses a reference to a source the registry does not hold', () => {
    const unknown = item();
    unknown.publicModule.evidence = { kind: 'reference', sourceId: 'etg-antibiotics' };
    unknown.publicModule.review.contentHash = moduleItemContentHash(unknown);
    expect(decidePublicModuleQuestion(unknown, registry)).toMatchObject({ eligible: false, reason: 'unknown-source' });
  });

  it('refuses anything not mirrored and CC-BY-4.0', () => {
    const generated = item();
    (generated.publicModule as { origin: string }).origin = 'generated';
    expect(decidePublicModuleQuestion(generated, registry)).toMatchObject({ eligible: false, reason: 'not-mirrored' });
    const licensed = item();
    (licensed.publicModule.itemText as { licence: string }).licence = 'CC-BY-NC-4.0';
    expect(decidePublicModuleQuestion(licensed, registry)).toMatchObject({ eligible: false, reason: 'item-licence' });
  });

  it('refuses an item outside its discipline module, or in no known discipline', () => {
    expect(decidePublicModuleQuestion(item({ moduleNodes: ['cohort/resp'] }), registry))
      .toMatchObject({ eligible: false, reason: 'module-mismatch' });
    const unknown = item();
    (unknown.publicModule as { discipline: string }).discipline = 'cah';
    unknown.moduleNodes = ['cohort/cah'];
    expect(decidePublicModuleQuestion(unknown, registry)).toMatchObject({ eligible: false, reason: 'unknown-discipline' });
  });

  it('refuses an item carrying an image: the mirror ships none yet', () => {
    expect(decidePublicModuleQuestion(item({ imageUrl: '/figures/restricted/x.jpg' }), registry))
      .toMatchObject({ eligible: false, reason: 'image-not-allowed' });
  });

  it('never needs a quote: a reference is cited, not reproduced', () => {
    const quoted = item();
    (quoted.publicModule.evidence as Record<string, unknown>).quote = 'Infants under 3 months need a full septic screen';
    quoted.publicModule.review.contentHash = moduleItemContentHash(quoted);
    expect(decidePublicModuleQuestion(quoted, registry)).toMatchObject({ eligible: false, reason: 'reference-quoted' });
  });
});

describe('buildModuleArtifacts', () => {
  const pub = {
    id: 'open:paeds:q-0123456789ab:v1',
    origin: 'md3:0123456789abcdef',
    discipline: 'paeds' as const,
    stem: 'A febrile 6-week-old …',
    options: [
      { label: 'A', text: 'Full septic workup', isCorrect: true, explanation: 'Under 3 months.' },
      { label: 'B', text: 'Oral antibiotics and review', isCorrect: false, explanation: 'Too young.' },
    ],
    context: null,
    topics: ['fever'],
    difficulty: 'medium',
    questionType: null,
    reference: { title: 'Febrile child', url: 'https://www.rch.org.au/x', publisher: 'RCH' },
    licence: 'CC-BY-4.0' as const,
    attribution: 'MD3 contributors' as const,
  };
  const references = {
    'rch-fever': { title: 'Febrile child', publisher: 'RCH', url: 'https://www.rch.org.au/x', verifiedAt: '2026-09-23' },
    'unused-source': { title: 'Unused', publisher: null, url: 'https://example.org', verifiedAt: '2026-09-23' },
  };

  const built = buildModuleArtifacts([{ question: pub, sourceId: 'rch-fever' }], references);

  it('writes each item where its discipline module lives, with a stable module id', () => {
    const [[path, file]] = [...built.files];
    expect(path).toBe('open-content/modules/questions/paeds/q-0123456789ab.v1.json');
    expect(file.id).toBe('bank:cohort:paeds:q-0123456789ab:v1');
    expect(file.moduleNodes).toEqual(['cohort/paeds']);
    expect(file.publicModule.mirroredFrom).toBe('md3:0123456789abcdef');
  });

  it('produces items the publication gate accepts', () => {
    for (const file of built.files.values()) {
      expect(decidePublicModuleQuestion(file, built.sources)).toEqual({ eligible: true });
    }
  });

  it('registers only the sources that are cited, as citable-not-redistributable', () => {
    expect(Object.keys(built.sources.sources)).toEqual(['rch-fever']);
    expect(built.sources.sources['rch-fever'].licence).toEqual({ cls: 'verify' });
  });

  it('lists the release in id order, so a regenerated manifest does not churn', () => {
    const two = buildModuleArtifacts([
      { question: { ...pub, id: 'open:resp:q-ffffffffffff:v1', discipline: 'resp' as const }, sourceId: 'rch-fever' },
      { question: pub, sourceId: 'rch-fever' },
    ], references);
    expect(two.release.questionIds).toEqual(['bank:cohort:paeds:q-0123456789ab:v1', 'bank:cohort:resp:q-ffffffffffff:v1']);
  });


  it('writes original questions to their own lane with truthful authored provenance', () => {
    const original = buildOriginalModuleArtifacts([
      { question: { ...pub, id: 'cohort:anatomy:q-0123456789ab:v1', discipline: 'anatomy' as const }, sourceId: 'rch-fever', originalId: 'abducens-function' },
    ], references);
    const [[path, file]] = [...original.files];
    expect(path).toBe('open-content/modules/original-questions/anatomy/q-0123456789ab.v1.json');
    expect(file.publicModule.origin).toBe('original');
    expect(file.publicModule.originalId).toBe('abducens-function');
    expect(file.publicModule.mirroredFrom).toBeUndefined();
    expect(decidePublicModuleQuestion(file, original.sources)).toEqual({ eligible: true });
  });

  it('refuses an item without exactly one key or with an unexplained option', () => {
    const noExplanation = { ...pub, options: [{ label: 'A', text: 'Full septic workup', isCorrect: true }, pub.options[1]] };
    expect(() => buildModuleArtifacts([{ question: noExplanation, sourceId: 'rch-fever' }], references)).toThrow(/explanation/);
    const noKey = { ...pub, options: pub.options.map((o) => ({ ...o, isCorrect: false })) };
    expect(() => buildModuleArtifacts([{ question: noKey, sourceId: 'rch-fever' }], references)).toThrow(/one correct/);
  });

  it('records which source each released question cites, for a host that reads rows without the files', () => {
    expect(built.release.questionSources).toEqual({ 'bank:cohort:paeds:q-0123456789ab:v1': 'rch-fever' });
  });

  it('refuses a cited source it cannot resolve rather than shipping an unverified reference', () => {
    expect(() => buildModuleArtifacts([{ question: pub, sourceId: 'missing' }], references)).toThrow(/missing/);
  });
});
