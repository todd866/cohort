import { describe, expect, it } from 'vitest';
import {
  buildQuestionCitationEnvelope,
  decidePublicUsmleQuestion,
  parsePublicUsmleProvenance,
  type PublicUsmleProvenanceV1,
  type PublicUsmleQuestionCandidate,
} from './public-corpus';

const authoredPassage: PublicUsmleProvenanceV1 = {
  schemaVersion: 1,
  origin: 'authored',
  itemText: { licence: 'CC-BY-4.0', attribution: 'Ian Todd / md3' },
  evidence: {
    kind: 'passage',
    sourceId: 'doi:10.1000/example',
    passageId: 'md5-example#42',
    licence: { cls: 'foss', id: 'cc-by-4.0' },
  },
};

const generatedFoss: PublicUsmleProvenanceV1 = {
  schemaVersion: 1,
  origin: 'generated',
  itemText: { licence: 'CC-BY-4.0', attribution: 'Ian Todd / md3' },
  evidence: {
    kind: 'passage',
    sourceId: 'doi:10.1000/example',
    passageId: 'md5-example#42',
    licence: { cls: 'foss', id: 'cc-by-4.0' },
  },
};

function candidate(
  overrides: Partial<PublicUsmleQuestionCandidate> = {},
  provenance: PublicUsmleProvenanceV1 | null = authoredPassage,
): PublicUsmleQuestionCandidate {
  return {
    id: 'bank:cah:step1-example:v1',
    rotation: 'cah',
    moduleNodes: ['cah', 'usmle/step1'],
    source: 'bank',
    sourceFile: 'question-bank/cah/step1-example.v1.json',
    imageUrl: null,
    contentState: 'enhanced',
    excluded: false,
    citations: provenance ? { publicUsmle: provenance } : null,
    annotations: null,
    ...overrides,
  };
}

describe('parsePublicUsmleProvenance', () => {
  it('round-trips the seeder citation envelope without discarding a bibliography cite', () => {
    const envelope = buildQuestionCitationEnvelope('source#section', generatedFoss);
    expect(envelope).toEqual({
      cite: 'source#section',
      publicUsmle: generatedFoss,
    });
    expect(parsePublicUsmleProvenance(envelope)).toEqual({
      ok: true,
      provenance: generatedFoss,
    });
  });

  it('distinguishes absent provenance from an explicit revocation', () => {
    expect(buildQuestionCitationEnvelope(null, undefined)).toBeNull();
    const revoked = buildQuestionCitationEnvelope(null, null);
    expect(revoked).toEqual({ publicUsmle: null });
    expect(parsePublicUsmleProvenance(revoked)).toEqual(expect.objectContaining({
      ok: false,
      reason: 'provenance-invalid',
    }));
  });

  it('does not infer provenance from legacy FOSS-looking annotations', () => {
    const parsed = parsePublicUsmleProvenance(null);
    expect(parsed).toEqual(expect.objectContaining({
      ok: false,
      reason: 'provenance-missing',
    }));
  });

  it('rejects malformed or future provenance instead of guessing', () => {
    const parsed = parsePublicUsmleProvenance({
      publicUsmle: { ...generatedFoss, schemaVersion: 2 },
    });
    expect(parsed).toEqual(expect.objectContaining({
      ok: false,
      reason: 'provenance-invalid',
    }));
  });
});

describe('decidePublicUsmleQuestion', () => {
  it('accepts explicitly CC-BY authored content with passage grounding', () => {
    const decision = decidePublicUsmleQuestion(candidate());
    expect(decision).toEqual(expect.objectContaining({
      eligible: true,
      reason: 'eligible-authored',
      renderEvidenceQuote: true,
    }));
  });

  it('rejects source-free authored content so every public answer has a citation trail', () => {
    const decision = decidePublicUsmleQuestion(candidate({}, {
      ...authoredPassage,
      evidence: { kind: 'none' },
    }));
    expect(decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'authored-grounding-required',
    }));
  });

  it('does not use primary rotation as corpus membership', () => {
    const decision = decidePublicUsmleQuestion(candidate({
      rotation: 'usmle-step1',
      moduleNodes: [],
    }));
    expect(decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'not-step1-member',
    }));
  });

  it('fails closed when the durable provenance envelope is absent', () => {
    const decision = decidePublicUsmleQuestion(candidate({
      annotations: {
        source: 'foss-grounded-vignette',
        groundedOn: 'some passage',
      },
    }, null));
    expect(decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'provenance-missing',
    }));
  });

  it('rejects image-bearing items until media has independent licence provenance', () => {
    const decision = decidePublicUsmleQuestion(candidate({ imageUrl: '/figures/example.png' }));
    expect(decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'media-provenance-required',
    }));
  });

  it('accepts generated content only with passage-level FOSS grounding', () => {
    const decision = decidePublicUsmleQuestion(candidate({}, generatedFoss));
    expect(decision).toEqual(expect.objectContaining({
      eligible: true,
      reason: 'eligible-generated',
      renderEvidenceQuote: true,
    }));
  });

  it.each(['verify', 'unknown'] as const)(
    'rejects generated content with %s evidence',
    (cls) => {
      const provenance: PublicUsmleProvenanceV1 = {
        ...generatedFoss,
        evidence: {
          kind: 'passage',
          sourceId: 'doi:10.1000/example',
          passageId: 'md5-example#42',
          licence: { cls, id: cls === 'verify' ? 'cc-by-nc-nd' : 'unresolved' },
        },
      };
      const decision = decidePublicUsmleQuestion(candidate({}, provenance));
      expect(decision).toEqual(expect.objectContaining({
        eligible: false,
        reason: 'generated-evidence-not-foss',
      }));
    },
  );

  it('rejects a generated source whose FOSS class contradicts its licence id', () => {
    const provenance: PublicUsmleProvenanceV1 = {
      ...generatedFoss,
      evidence: {
        kind: 'passage',
        sourceId: 'book:first-aid-step1',
        passageId: 'chapter-2#p17',
        licence: { cls: 'foss', id: 'all-rights-reserved' },
      },
    };
    const decision = decidePublicUsmleQuestion(candidate({
      citations: {
        cite: 'First Aid for the USMLE Step 1, chapter 2',
        publicUsmle: provenance,
      },
    }, provenance));
    expect(decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'generated-evidence-not-foss',
    }));
  });

  it('rejects generated content without a traceable passage', () => {
    const provenance: PublicUsmleProvenanceV1 = {
      ...generatedFoss,
      evidence: {
        kind: 'reference',
        sourceId: 'doi:10.1000/example',
        licence: { cls: 'foss', id: 'cc-by-4.0' },
      },
    };
    const decision = decidePublicUsmleQuestion(candidate({}, provenance));
    expect(decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'generated-grounding-required',
    }));
  });

  it('rejects authored text grounded against restrictive evidence', () => {
    const provenance: PublicUsmleProvenanceV1 = {
      ...authoredPassage,
      evidence: {
        kind: 'passage',
        sourceId: 'book:first-aid-step1',
        passageId: 'chapter-2#p17',
        licence: { cls: 'verify', id: 'all-rights-reserved' },
      },
    };
    const decision = decidePublicUsmleQuestion(candidate({
      citations: {
        cite: 'First Aid for the USMLE Step 1, chapter 2',
        publicUsmle: provenance,
      },
    }, provenance));
    expect(decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'authored-evidence-not-foss',
    }));
  });

  it('allows a FOSS evidence quote for openly licensed authored text', () => {
    const provenance: PublicUsmleProvenanceV1 = {
      ...authoredPassage,
      evidence: generatedFoss.evidence,
    };
    const decision = decidePublicUsmleQuestion(candidate({}, provenance));
    expect(decision).toEqual(expect.objectContaining({
      eligible: true,
      renderEvidenceQuote: true,
    }));
  });

  it('rejects authored evidence whose FOSS class has an unapproved id', () => {
    const provenance: PublicUsmleProvenanceV1 = {
      ...authoredPassage,
      evidence: {
        kind: 'passage',
        sourceId: 'source:contradictory',
        passageId: 'passage-1',
        licence: { cls: 'foss', id: 'all-rights-reserved' },
      },
    };
    const decision = decidePublicUsmleQuestion(candidate({}, provenance));
    expect(decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'authored-evidence-not-foss',
    }));
  });

  it('rejects authored wording whose own licence is unresolved', () => {
    const provenance: PublicUsmleProvenanceV1 = {
      ...authoredPassage,
      itemText: { licence: 'unknown', attribution: 'unknown' },
    };
    const decision = decidePublicUsmleQuestion(candidate({}, provenance));
    expect(decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'item-text-licence-not-public',
    }));
  });

  it.each([
    'anking',
    'y3g-reshape',
    'legacy-instagram',
    'first-aid-derived',
    'source-derived',
    'unknown',
  ] as const)('rejects explicit %s origin', (origin) => {
    const provenance: PublicUsmleProvenanceV1 = { ...authoredPassage, origin };
    const decision = decidePublicUsmleQuestion(candidate({}, provenance));
    expect(decision).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'origin-not-public',
    }));
  });

  it.each([
    ['anking', { rotation: 'anking' }, 'known-anking-source'],
    ['AnKing citation', { citations: { cite: 'anking:note-123', publicUsmle: authoredPassage } }, 'known-anking-source'],
    ['Y3G', { id: 'bank:cah:y3g-example:v1' }, 'known-y3g-source'],
    ['Y3G citation', { citations: { cite: 'y3g:deck-123', publicUsmle: authoredPassage } }, 'known-y3g-source'],
    ['Instagram', { citations: { cite: 'instagram:@usmle_pearls:abc', publicUsmle: authoredPassage } }, 'known-instagram-source'],
    ['First Aid source text', { sourceFile: 'question-bank/usmle/first-aid-import.json' }, 'known-first-aid-source'],
  ] as const)('hard-denies known %s metadata even if mislabeled authored', (_label, overrides, reason) => {
    const decision = decidePublicUsmleQuestion(candidate(overrides));
    expect(decision).toEqual(expect.objectContaining({ eligible: false, reason }));
  });

  it.each([
    [{ excluded: true }, 'excluded'],
    [{ contentState: 'raw' }, 'unservable-state'],
    [{ contentState: 'shelved' }, 'unservable-state'],
  ] as const)('rejects unavailable content %#', (overrides, reason) => {
    const decision = decidePublicUsmleQuestion(candidate(overrides));
    expect(decision).toEqual(expect.objectContaining({ eligible: false, reason }));
  });
});
