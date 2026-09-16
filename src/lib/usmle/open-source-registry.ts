import { createHash } from 'node:crypto';
import { z } from 'zod';

const MAX_URL_LENGTH = 2_048;
const MILLISECONDS_PER_DAY = 86_400_000;

export const OPEN_USMLE_SOURCE_RECEIPT_MAX_AGE_DAYS = 90;

const StableIdSchema = z.string().trim().min(1).max(120).regex(
  /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/,
  'must be a lowercase stable identifier',
);

const HttpsUrlSchema = z.string().trim().min(1).max(MAX_URL_LENGTH).url().refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'must use https');

const LicenceSchema = z.object({
  cls: z.enum(['foss', 'verify', 'unknown']),
  id: StableIdSchema,
  url: HttpsUrlSchema,
}).strict();

const PassageSchema = z.object({
  id: StableIdSchema,
  locator: z.string().trim().min(1).max(500),
  quote: z.string().trim().min(1).max(2_000).optional(),
}).strict();

const SourceSchema = z.object({
  id: StableIdSchema,
  title: z.string().trim().min(1).max(300),
  publisher: z.string().trim().min(1).max(200),
  canonicalUrl: HttpsUrlSchema,
  attribution: z.string().trim().min(1).max(700),
  licence: LicenceSchema,
  passages: z.array(PassageSchema).min(1).max(500),
}).strict();

const RegistrySchema = z.object({
  schemaVersion: z.literal(1),
  /** Date on which every canonical URL, licence URL, and quoted passage was rechecked. */
  verifiedAt: z.string().date(),
  /** Tamper-evident digest over ordered [source id, passage id, quote] tuples. */
  quoteSetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Tamper-evident digest over the dated registry metadata and passage set. */
  registrySha256: z.string().regex(/^[a-f0-9]{64}$/),
  sources: z.array(SourceSchema).min(1).max(500),
}).strict();

export type OpenUsmleSource = z.infer<typeof SourceSchema>;
export type OpenUsmlePassage = z.infer<typeof PassageSchema>;

export interface OpenUsmleSourceRegistry {
  schemaVersion: 1;
  verifiedAt: string;
  quoteSetSha256: string;
  registrySha256: string;
  sources: OpenUsmleSource[];
  sourceById: Map<string, OpenUsmleSource>;
  passageByKey: Map<string, OpenUsmlePassage>;
}

export type OpenUsmleEvidenceReference =
  | { kind: 'none' }
  | {
      kind: 'reference';
      sourceId: string;
      licence: { cls: 'foss' | 'verify' | 'unknown'; id: string };
    }
  | {
      kind: 'passage';
      sourceId: string;
      passageId: string;
      licence: { cls: 'foss' | 'verify' | 'unknown'; id: string };
    };

export function openUsmlePassageKey(sourceId: string, passageId: string): string {
  return `${sourceId}:${passageId}`;
}

/**
 * Digest only the verbatim quote set and its stable coordinates. URL/licence
 * changes remain visible in source control, while any quote edit must also
 * update this independently reviewable verification receipt.
 */
export function computeOpenUsmleQuoteSetSha256(
  sources: readonly OpenUsmleSource[],
): string {
  const quoteSet = sources.flatMap((source) => source.passages.flatMap((passage) => (
    passage.quote ? [[source.id, passage.id, passage.quote]] : []
  )));
  return createHash('sha256').update(JSON.stringify(quoteSet)).digest('hex');
}

/** Digest every release-relevant registry field without relying on object key order. */
export function computeOpenUsmleRegistrySha256(
  verifiedAt: string,
  sources: readonly OpenUsmleSource[],
): string {
  const receipt = [
    verifiedAt,
    sources.map((source) => [
      source.id,
      source.title,
      source.publisher,
      source.canonicalUrl,
      source.attribution,
      source.licence.cls,
      source.licence.id,
      source.licence.url,
      source.passages.map((passage) => [
        passage.id,
        passage.locator,
        passage.quote ?? null,
      ]),
    ]),
  ];
  return createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
}

/**
 * Release-time freshness check for the independently reviewable source receipt.
 * Normal offline builds remain reproducible; only release/seed gates require a
 * recent recheck of every URL, reuse term, and exact quoted passage.
 */
export function openUsmleSourceReceiptFailures(
  registry: Pick<OpenUsmleSourceRegistry, 'verifiedAt'>,
  today = new Date().toISOString().slice(0, 10),
  maxAgeDays = OPEN_USMLE_SOURCE_RECEIPT_MAX_AGE_DAYS,
): string[] {
  if (!RegistrySchema.shape.verifiedAt.safeParse(today).success) {
    throw new Error('today must be an ISO 8601 calendar date');
  }
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
    throw new Error('maxAgeDays must be a non-negative integer');
  }

  const verifiedAtMs = Date.parse(`${registry.verifiedAt}T00:00:00.000Z`);
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  const ageDays = Math.round((todayMs - verifiedAtMs) / MILLISECONDS_PER_DAY);
  if (ageDays < 0) {
    return [
      `source registry verification date ${registry.verifiedAt} is ${Math.abs(ageDays)} day(s) in the future`,
    ];
  }
  if (ageDays > maxAgeDays) {
    return [
      `source registry verification receipt is ${ageDays} day(s) old; release requires re-verification every ${maxAgeDays} days`,
    ];
  }
  return [];
}

/** Parse a checked-in source registry and build deterministic lookup indexes. */
export function parseOpenUsmleSourceRegistry(input: unknown): OpenUsmleSourceRegistry {
  const parsed = RegistrySchema.parse(input);
  const sourceById = new Map<string, OpenUsmleSource>();
  const passageByKey = new Map<string, OpenUsmlePassage>();

  for (const source of parsed.sources) {
    if (sourceById.has(source.id)) {
      throw new Error(`Duplicate source id ${source.id}`);
    }
    const hostname = new URL(source.canonicalUrl).hostname.toLowerCase();
    if (hostname === 'cdc.gov' || hostname.endsWith('.cdc.gov')) {
      const attribution = source.attribution.toLowerCase();
      if (
        !attribution.includes('cdc')
        || !attribution.includes('no charge')
        || !attribution.includes('endorsement')
      ) {
        throw new Error(
          `CDC source ${source.id} attribution must identify CDC, state no-charge availability, and disclaim endorsement`,
        );
      }
    }
    sourceById.set(source.id, source);

    const passageIds = new Set<string>();
    for (const passage of source.passages) {
      if (passageIds.has(passage.id)) {
        throw new Error(`Duplicate passage id ${passage.id} for source ${source.id}`);
      }
      passageIds.add(passage.id);
      passageByKey.set(openUsmlePassageKey(source.id, passage.id), passage);
    }
  }

  const quoteSetSha256 = computeOpenUsmleQuoteSetSha256(parsed.sources);
  if (quoteSetSha256 !== parsed.quoteSetSha256) {
    throw new Error(
      `Source-registry quote digest mismatch: expected ${parsed.quoteSetSha256}, computed ${quoteSetSha256}`,
    );
  }
  const registrySha256 = computeOpenUsmleRegistrySha256(
    parsed.verifiedAt,
    parsed.sources,
  );
  if (registrySha256 !== parsed.registrySha256) {
    throw new Error(
      `Source-registry receipt digest mismatch: expected ${parsed.registrySha256}, computed ${registrySha256}`,
    );
  }

  return {
    schemaVersion: parsed.schemaVersion,
    verifiedAt: parsed.verifiedAt,
    quoteSetSha256: parsed.quoteSetSha256,
    registrySha256: parsed.registrySha256,
    sources: parsed.sources,
    sourceById,
    passageByKey,
  };
}

/**
 * Cross-check one question's evidence pointer against the checked-in registry.
 * The question envelope may not claim a more permissive licence than the
 * source registry, even when both strings happen to look open.
 */
export function validateOpenUsmleSourceReference(
  registry: OpenUsmleSourceRegistry,
  evidence: OpenUsmleEvidenceReference,
): string[] {
  if (evidence.kind === 'none') return [];

  const source = registry.sourceById.get(evidence.sourceId);
  if (!source) return [`Unknown source ${evidence.sourceId}`];

  const errors: string[] = [];
  const claimedClass = evidence.licence.cls;
  const claimedId = evidence.licence.id.trim().toLowerCase();
  const registeredClass = source.licence.cls;
  const registeredId = source.licence.id.trim().toLowerCase();
  if (claimedClass !== registeredClass || claimedId !== registeredId) {
    errors.push(
      `Licence mismatch for source ${source.id}: question claims `
      + `${claimedClass}/${claimedId}, registry records ${registeredClass}/${registeredId}`,
    );
  }

  if (evidence.kind === 'passage') {
    const passage = registry.passageByKey.get(
      openUsmlePassageKey(evidence.sourceId, evidence.passageId),
    );
    if (!passage) {
      errors.push(`Unknown passage ${evidence.passageId} for source ${source.id}`);
    } else if (!passage.quote) {
      errors.push(
        `Passage ${evidence.passageId} for source ${source.id} has no checked-in quote`,
      );
    }
  }

  return errors;
}
