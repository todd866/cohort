import { describe, expect, it } from 'vitest';
import {
  computeOpenUsmleRegistrySha256,
  computeOpenUsmleQuoteSetSha256,
  openUsmleSourceReceiptFailures,
  parseOpenUsmleSourceRegistry,
  validateOpenUsmleSourceReference,
} from './open-source-registry';

const sourceFixture = {
  id: 'cdc-vaccine-principles',
  title: 'Principles of Vaccination',
  publisher: 'Centers for Disease Control and Prevention',
  canonicalUrl: 'https://www.cdc.gov/pinkbook/hcp/table-of-contents/chapter-1-principles-of-vaccination.html',
  attribution: 'Source: Centers for Disease Control and Prevention (CDC). This material is also available from CDC at no charge. No endorsement is implied.',
  licence: {
    cls: 'foss' as const,
    id: 'us-gov',
    url: 'https://www.cdc.gov/other/agencymaterials.html',
  },
  passages: [
    {
      id: 'passive-immunity',
      locator: 'Types of Immunity > Passive Immunity',
      quote: 'A short redistributable passage.',
    },
  ],
};

const registryInput = {
  schemaVersion: 1,
  verifiedAt: '2026-08-01',
  quoteSetSha256: computeOpenUsmleQuoteSetSha256([sourceFixture]),
  registrySha256: computeOpenUsmleRegistrySha256('2026-08-01', [sourceFixture]),
  sources: [sourceFixture],
};

describe('open USMLE source registry', () => {
  it('parses a strict, versioned registry and indexes stable source and passage IDs', () => {
    const registry = parseOpenUsmleSourceRegistry(registryInput);

    expect(registry.sources).toHaveLength(1);
    expect(registry.verifiedAt).toBe('2026-08-01');
    expect(registry.quoteSetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.registrySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.sourceById.get('cdc-vaccine-principles')?.title).toBe(
      'Principles of Vaccination',
    );
    expect(
      registry.passageByKey.get('cdc-vaccine-principles:passive-immunity')?.locator,
    ).toContain('Passive Immunity');
  });

  it('rejects duplicate source IDs and duplicate passage IDs within a source', () => {
    expect(() => parseOpenUsmleSourceRegistry({
      ...registryInput,
      sources: [registryInput.sources[0], registryInput.sources[0]],
    })).toThrow(/duplicate source id cdc-vaccine-principles/i);

    expect(() => parseOpenUsmleSourceRegistry({
      ...registryInput,
      sources: [{
        ...registryInput.sources[0],
        passages: [
          registryInput.sources[0].passages[0],
          registryInput.sources[0].passages[0],
        ],
      }],
    })).toThrow(/duplicate passage id passive-immunity/i);
  });

  it('fails closed on malformed URLs and unversioned input', () => {
    expect(() => parseOpenUsmleSourceRegistry({
      ...registryInput,
      schemaVersion: 2,
    })).toThrow();

    expect(() => parseOpenUsmleSourceRegistry({
      ...registryInput,
      sources: [{
        ...registryInput.sources[0],
        canonicalUrl: 'not-a-url',
      }],
    })).toThrow();

    for (const canonicalUrl of [
      'http://example.test/source',
      'javascript:alert(1)',
      'data:text/html,answer',
      'file:///tmp/source',
    ]) {
      expect(() => parseOpenUsmleSourceRegistry({
        ...registryInput,
        sources: [{ ...registryInput.sources[0], canonicalUrl }],
      })).toThrow(/https|url/i);
    }
  });

  it('fails closed when a quote changes without a new verification digest', () => {
    expect(() => parseOpenUsmleSourceRegistry({
      ...registryInput,
      sources: [{
        ...registryInput.sources[0],
        passages: [{
          ...registryInput.sources[0].passages[0],
          quote: 'A changed passage without a refreshed receipt.',
        }],
      }],
    })).toThrow(/quote digest mismatch/i);
  });

  it('fails closed when source metadata changes without a new registry receipt', () => {
    expect(() => parseOpenUsmleSourceRegistry({
      ...registryInput,
      sources: [{
        ...registryInput.sources[0],
        canonicalUrl: 'https://www.cdc.gov/other/changed-source.html',
      }],
    })).toThrow(/receipt digest mismatch/i);
  });

  it('requires a current, non-future verification receipt at release time', () => {
    const registry = parseOpenUsmleSourceRegistry(registryInput);

    expect(openUsmleSourceReceiptFailures(registry, '2026-10-30')).toEqual([]);
    expect(openUsmleSourceReceiptFailures(registry, '2026-10-31')).toEqual([
      'source registry verification receipt is 91 day(s) old; release requires re-verification every 90 days',
    ]);
    expect(openUsmleSourceReceiptFailures(registry, '2026-07-31')).toEqual([
      'source registry verification date 2026-08-01 is 1 day(s) in the future',
    ]);
    expect(() => openUsmleSourceReceiptFailures(registry, 'not-a-date')).toThrow(
      /ISO 8601 calendar date/i,
    );
    expect(() => openUsmleSourceReceiptFailures(registry, '2026-08-01', -1)).toThrow(
      /non-negative integer/i,
    );
  });

  it('enforces the CDC attribution and no-charge conditions recorded by its reuse policy', () => {
    const incomplete = {
      ...sourceFixture,
      attribution: 'Source: CDC.',
    };
    expect(() => parseOpenUsmleSourceRegistry({
      ...registryInput,
      quoteSetSha256: computeOpenUsmleQuoteSetSha256([incomplete]),
      sources: [incomplete],
    })).toThrow(/no-charge.*endorsement/i);
  });

  it('validates exact source, passage, and licence agreement', () => {
    const registry = parseOpenUsmleSourceRegistry(registryInput);

    expect(validateOpenUsmleSourceReference(registry, {
      kind: 'passage',
      sourceId: 'cdc-vaccine-principles',
      passageId: 'passive-immunity',
      licence: { cls: 'foss', id: 'us-gov' },
    })).toEqual([]);

    expect(validateOpenUsmleSourceReference(registry, {
      kind: 'passage',
      sourceId: 'cdc-vaccine-principles',
      passageId: 'missing',
      licence: { cls: 'foss', id: 'us-gov' },
    })).toEqual([expect.stringMatching(/unknown passage/i)]);

    expect(validateOpenUsmleSourceReference(registry, {
      kind: 'reference',
      sourceId: 'cdc-vaccine-principles',
      licence: { cls: 'foss', id: 'public-domain' },
    })).toEqual([expect.stringMatching(/licence mismatch/i)]);
  });

  it('treats no evidence as having no registry pointer to validate', () => {
    const registry = parseOpenUsmleSourceRegistry(registryInput);
    // Public eligibility separately requires an exact passage for every item.
    expect(validateOpenUsmleSourceReference(registry, { kind: 'none' })).toEqual([]);
  });

  it('rejects a passage pointer without an exact checked-in quote', () => {
    const quoteLessSource = {
      ...sourceFixture,
      canonicalUrl: 'https://example.gov/source',
      passages: [{ id: 'passive-immunity', locator: 'Section 1' }],
    };
    const registry = parseOpenUsmleSourceRegistry({
      ...registryInput,
      quoteSetSha256: computeOpenUsmleQuoteSetSha256([quoteLessSource]),
      registrySha256: computeOpenUsmleRegistrySha256('2026-08-01', [quoteLessSource]),
      sources: [quoteLessSource],
    });

    expect(validateOpenUsmleSourceReference(registry, {
      kind: 'passage',
      sourceId: quoteLessSource.id,
      passageId: 'passive-immunity',
      licence: { cls: 'foss', id: 'us-gov' },
    })).toEqual([expect.stringMatching(/no checked-in quote/i)]);
  });
});
