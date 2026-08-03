import { z } from 'zod';

/** The cross-rotation membership that defines the public Step 1 corpus. */
export const USMLE_STEP1_PUBLIC_MODULE = 'usmle/step1' as const;

/**
 * Content licences accepted for md3-owned question text.
 *
 * Code licensing is separate (the application is MIT). Question wording is
 * educational content, so it needs an explicit content licence of its own.
 */
export const PUBLIC_USMLE_TEXT_LICENCES = [
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC0-1.0',
] as const;

/** Normalised evidence-licence IDs that may unlock a verbatim public quote. */
export const PUBLIC_USMLE_EVIDENCE_LICENCE_IDS = [
  'cc0',
  'cc0-1.0',
  'public-domain',
  'us-gov',
  'cc-by',
  'cc-by-2.0',
  'cc-by-2.5',
  'cc-by-3.0',
  'cc-by-4.0',
  'cc-by-sa',
  'cc-by-sa-2.0',
  'cc-by-sa-2.5',
  'cc-by-sa-3.0',
  'cc-by-sa-4.0',
] as const;

const ItemTextLicenceSchema = z.enum([
  ...PUBLIC_USMLE_TEXT_LICENCES,
  'restricted',
  'unknown',
]);

const EvidenceLicenceSchema = z.object({
  cls: z.enum(['foss', 'verify', 'unknown']),
  id: z.string().trim().min(1),
}).strict();

const EvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('none'),
  }).strict(),
  z.object({
    kind: z.literal('reference'),
    sourceId: z.string().trim().min(1),
    licence: EvidenceLicenceSchema,
  }).strict(),
  z.object({
    kind: z.literal('passage'),
    sourceId: z.string().trim().min(1),
    passageId: z.string().trim().min(1),
    licence: EvidenceLicenceSchema,
  }).strict(),
]);

/**
 * Durable provenance stored at `Question.citations.publicUsmle`.
 *
 * `itemText` governs whether the question wording can be distributed.
 * `evidence` separately governs whether a supporting quote can be reproduced.
 * A bibliographic reference does not imply permission to reproduce its prose.
 */
export const PublicUsmleProvenanceV1Schema = z.object({
  schemaVersion: z.literal(1),
  origin: z.enum([
    'authored',
    'generated',
    'anking',
    'y3g-reshape',
    'legacy-instagram',
    'first-aid-derived',
    'source-derived',
    'unknown',
  ]),
  itemText: z.object({
    licence: ItemTextLicenceSchema,
    attribution: z.string().trim().min(1),
  }).strict(),
  evidence: EvidenceSchema,
}).strict();

export type PublicUsmleProvenanceV1 = z.infer<typeof PublicUsmleProvenanceV1Schema>;

export interface PublicUsmleQuestionCandidate {
  id: string;
  rotation: string;
  moduleNodes: readonly string[];
  source: string | null;
  sourceFile: string | null;
  imageUrl: string | null;
  contentState: string;
  excluded: boolean;
  citations: unknown;
  annotations: unknown;
}

export type PublicUsmleExclusionReason =
  | 'not-step1-member'
  | 'excluded'
  | 'unservable-state'
  | 'known-anking-source'
  | 'known-y3g-source'
  | 'known-instagram-source'
  | 'known-first-aid-source'
  | 'media-provenance-required'
  | 'provenance-missing'
  | 'provenance-invalid'
  | 'origin-not-public'
  | 'item-text-licence-not-public'
  | 'authored-grounding-required'
  | 'generated-grounding-required'
  | 'authored-evidence-not-foss'
  | 'generated-evidence-not-foss';

export type PublicUsmleDecision =
  | {
      eligible: true;
      reason: 'eligible-authored' | 'eligible-generated';
      provenance: PublicUsmleProvenanceV1;
      /** A later public renderer may fetch/show the source passage only when true. */
      renderEvidenceQuote: boolean;
    }
  | {
      eligible: false;
      reason: PublicUsmleExclusionReason;
      detail: string;
    };

type ProvenanceParseResult =
  | { ok: true; provenance: PublicUsmleProvenanceV1 }
  | { ok: false; reason: 'provenance-missing' | 'provenance-invalid'; detail: string };

const PUBLIC_CONTENT_STATES = new Set(['validated', 'enhanced', 'cited', 'production']);
const PUBLIC_TEXT_LICENCE_SET = new Set<string>(PUBLIC_USMLE_TEXT_LICENCES);
const PUBLIC_EVIDENCE_LICENCE_ID_SET = new Set<string>(PUBLIC_USMLE_EVIDENCE_LICENCE_IDS);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function metadataString(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

function isPublicEvidenceLicence(licence: { cls: string; id: string }): boolean {
  return licence.cls === 'foss'
    && PUBLIC_EVIDENCE_LICENCE_ID_SET.has(licence.id.trim().toLowerCase());
}

/** Build the JSONB envelope persisted in Question.citations by the bank seeder. */
export function buildQuestionCitationEnvelope(
  cite: string | null | undefined,
  publicUsmle: PublicUsmleProvenanceV1 | null | undefined,
): Record<string, unknown> | null {
  const hasExplicitPublicUsmle = publicUsmle !== undefined;
  if (!cite && !hasExplicitPublicUsmle) return null;
  return {
    ...(cite ? { cite } : {}),
    ...(hasExplicitPublicUsmle ? { publicUsmle: publicUsmle ?? null } : {}),
  };
}

/** Parse the versioned public provenance envelope. Missing/invalid is never inferred. */
export function parsePublicUsmleProvenance(citations: unknown): ProvenanceParseResult {
  const envelope = asRecord(citations);
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'publicUsmle')) {
    return {
      ok: false,
      reason: 'provenance-missing',
      detail: 'Question.citations.publicUsmle is required for public eligibility',
    };
  }

  const parsed = PublicUsmleProvenanceV1Schema.safeParse(envelope.publicUsmle);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      reason: 'provenance-invalid',
      detail: first
        ? `publicUsmle.${first.path.join('.') || '(root)'}: ${first.message}`
        : 'publicUsmle provenance did not match schema version 1',
    };
  }

  return { ok: true, provenance: parsed.data };
}

function knownSourceExclusion(
  candidate: PublicUsmleQuestionCandidate,
): Pick<Extract<PublicUsmleDecision, { eligible: false }>, 'reason' | 'detail'> | null {
  const citations = asRecord(candidate.citations);
  const annotations = asRecord(candidate.annotations);
  const cite = metadataString(citations, 'cite');
  const annotationSource = metadataString(annotations, 'source');
  const sourceSignals = [candidate.id, candidate.rotation, candidate.source ?? '', candidate.sourceFile ?? '', annotationSource];
  const allSignals = [...sourceSignals, cite];

  if (allSignals.some((value) => /(?:^|[/:_-])anking(?:$|[/:_-])/i.test(value))) {
    return { reason: 'known-anking-source', detail: 'AnKing-derived material is private and never public' };
  }
  if (allSignals.some((value) => /(?:^|[/:_-])y3g(?:$|[/:_-])|y3\s+g\s+cohort\s+anki/i.test(value))) {
    return { reason: 'known-y3g-source', detail: 'student-deck-derived material requires separate permission' };
  }
  if (allSignals.some((value) => /instagram|ig-usmle-pearls|usmle[_-]pearls/i.test(value))) {
    return { reason: 'known-instagram-source', detail: 'legacy Instagram-derived questions are not public corpus material' };
  }
  // First Aid is intentionally checked only as an origin/source signal, not as
  // a bibliography cite. The evidence-licence gate below independently keeps
  // restrictive passages out of the checked-in FOSS release registry.
  if (sourceSignals.some((value) => /first[\s_-]*aid/i.test(value))) {
    return { reason: 'known-first-aid-source', detail: 'First Aid/source-text-derived material is not redistributable' };
  }

  return null;
}

/**
 * Pure, fail-closed eligibility decision for one server-loaded question.
 *
 * Membership is defined only by `moduleNodes`; `rotation` is merely the item's
 * scheduling home and must never be used as the public corpus selector.
 */
export function decidePublicUsmleQuestion(
  candidate: PublicUsmleQuestionCandidate,
): PublicUsmleDecision {
  if (!candidate.moduleNodes.includes(USMLE_STEP1_PUBLIC_MODULE)) {
    return {
      eligible: false,
      reason: 'not-step1-member',
      detail: `moduleNodes must include ${USMLE_STEP1_PUBLIC_MODULE}`,
    };
  }
  if (candidate.excluded) {
    return { eligible: false, reason: 'excluded', detail: 'question is explicitly excluded' };
  }
  if (!PUBLIC_CONTENT_STATES.has(candidate.contentState)) {
    return {
      eligible: false,
      reason: 'unservable-state',
      detail: `contentState ${candidate.contentState || '(missing)'} is not public-ready`,
    };
  }

  const knownExclusion = knownSourceExclusion(candidate);
  if (knownExclusion) return { eligible: false, ...knownExclusion };

  // The v1 contract licenses question text and evidence, not third-party media.
  // Reject image-bearing items until media gets its own versioned provenance.
  if (candidate.imageUrl) {
    return {
      eligible: false,
      reason: 'media-provenance-required',
      detail: 'image-bearing questions require a future typed media-licence contract',
    };
  }

  const parsed = parsePublicUsmleProvenance(candidate.citations);
  if (!parsed.ok) return { eligible: false, reason: parsed.reason, detail: parsed.detail };
  const provenance = parsed.provenance;

  if (provenance.origin !== 'authored' && provenance.origin !== 'generated') {
    return {
      eligible: false,
      reason: 'origin-not-public',
      detail: `origin ${provenance.origin} is not accepted on the public USMLE surface`,
    };
  }
  if (!PUBLIC_TEXT_LICENCE_SET.has(provenance.itemText.licence)) {
    return {
      eligible: false,
      reason: 'item-text-licence-not-public',
      detail: `item text licence ${provenance.itemText.licence} is not distributable`,
    };
  }

  if (provenance.evidence.kind !== 'passage') {
    if (provenance.origin === 'generated') {
      return {
        eligible: false,
        reason: 'generated-grounding-required',
        detail: 'generated items require a durable sourceId and passageId',
      };
    }
    return {
      eligible: false,
      reason: 'authored-grounding-required',
      detail: 'authored public Step 1 items require a durable sourceId and passageId',
    };
  }

  if (!isPublicEvidenceLicence(provenance.evidence.licence)) {
    const sourceLicence = `${provenance.evidence.licence.cls}/${provenance.evidence.licence.id}`;
    return provenance.origin === 'generated'
      ? {
          eligible: false,
          reason: 'generated-evidence-not-foss',
          detail: `generated source licence ${sourceLicence} is not an approved FOSS licence`,
        }
      : {
          eligible: false,
          reason: 'authored-evidence-not-foss',
          detail: `authored source licence ${sourceLicence} is not an approved FOSS licence`,
        };
  }

  return {
    eligible: true,
    reason: provenance.origin === 'generated' ? 'eligible-generated' : 'eligible-authored',
    provenance,
    renderEvidenceQuote: true,
  };
}
