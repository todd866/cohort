import { createHash } from 'node:crypto';

/** Card fields that define the pedagogical clip task, independent of media bytes. */
export interface ClipTaskInput {
  rotation: string;
  sourceFile?: string | null;
  front: string;
  back: string;
  context?: string | null;
  clipSlug?: string | null;
  clipRole?: string | null;
  clipCaption?: string | null;
}

export type ClipTaskReviewRole = 'prompt' | 'context';
export type ClipTaskReviewDecision = 'approved' | 'rejected';
export type ClipTaskKind =
  | 'motion-recognition'
  | 'living-anatomy'
  | 'procedure-sequence'
  | 'teaching-demonstration';

export interface ClipTaskViewportEvidence {
  laptop: string;
  phone: string;
}

export interface ClipTaskReviewEntry {
  fingerprint: string;
  clipSlug: string;
  role: ClipTaskReviewRole;
  decision: ClipTaskReviewDecision;
  taskKind: ClipTaskKind;
  sourceUrl: string;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  evidenceStartSeconds: number;
  evidenceEndSeconds: number;
  visibleEvidence: string;
  targetOrientation: string;
  closestAlternative: string;
  distinction: string;
  videoBenefit: string;
  postRevealTeaching: string;
  reviewedAt: string;
  mediaSha256: string;
  viewportEvidence: ClipTaskViewportEvidence;
}

export interface ClipTaskReviewLedger {
  schemaVersion: 1;
  legacyFingerprints: string[];
  reviews: ClipTaskReviewEntry[];
}

export type ClipTaskReviewFindingCode =
  | 'missing-review'
  | 'rejected-review'
  | 'stale-review-receipt'
  | 'clip-slug-mismatch'
  | 'clip-role-mismatch'
  | 'conflicting-approval'
  | 'answer-leak-in-prompt-caption';

export interface ClipTaskReviewFinding {
  code: ClipTaskReviewFindingCode;
  message: string;
  fingerprint: string;
  clipSlug?: string | null;
}

export interface ClipTaskReviewValidationResult {
  findings: ClipTaskReviewFinding[];
}

export class ClipTaskReviewLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClipTaskReviewLedgerError';
  }
}

const TASK_KINDS: readonly ClipTaskKind[] = [
  'motion-recognition',
  'living-anatomy',
  'procedure-sequence',
  'teaching-demonstration',
];

const SUBSTANTIVE_REVIEW_TEXT_KEYS = [
  'targetOrientation',
  'closestAlternative',
  'distinction',
  'videoBenefit',
  'postRevealTeaching',
] as const;

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function nullableText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return normalizeLineEndings(value);
}

/** Fixed-key canonical payload: null and absent optional fields hash identically. */
function canonicalClipTaskPayload(input: ClipTaskInput): Record<string, string | null> {
  return {
    rotation: normalizeLineEndings(input.rotation),
    sourceFile: nullableText(input.sourceFile),
    front: normalizeLineEndings(input.front),
    back: normalizeLineEndings(input.back),
    context: nullableText(input.context),
    clipSlug: nullableText(input.clipSlug),
    clipRole: nullableText(input.clipRole),
    clipCaption: nullableText(input.clipCaption),
  };
}

export function clipTaskFingerprint(input: ClipTaskInput): string {
  const payload = canonicalClipTaskPayload(input);
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isFiniteSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function clipTaskCardRole(input: ClipTaskInput): ClipTaskReviewRole {
  return input.clipRole === 'prompt' ? 'prompt' : 'context';
}

export function requiresClipTaskReview(input: ClipTaskInput): boolean {
  const slug = input.clipSlug?.trim();
  return slug != null && slug.length > 0;
}

function parseLedger(ledger: unknown): ClipTaskReviewLedger {
  if (ledger == null || typeof ledger !== 'object') {
    throw new ClipTaskReviewLedgerError('Clip task review ledger must be an object');
  }
  const record = ledger as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new ClipTaskReviewLedgerError('Clip task review ledger schemaVersion must be 1');
  }
  if (!Array.isArray(record.legacyFingerprints)) {
    throw new ClipTaskReviewLedgerError('Clip task review ledger legacyFingerprints must be an array');
  }
  if (!Array.isArray(record.reviews)) {
    throw new ClipTaskReviewLedgerError('Clip task review ledger reviews must be an array');
  }
  return {
    schemaVersion: 1,
    legacyFingerprints: record.legacyFingerprints as string[],
    reviews: record.reviews as ClipTaskReviewEntry[],
  };
}

function assertUniqueFingerprints(fingerprints: string[], label: string): void {
  const seen = new Set<string>();
  for (const fp of fingerprints) {
    if (!isSha256Hex(fp)) {
      throw new ClipTaskReviewLedgerError(`${label} contains a malformed fingerprint hash`);
    }
    const key = fp.toLowerCase();
    if (seen.has(key)) {
      throw new ClipTaskReviewLedgerError(`${label} contains duplicate fingerprint ${fp}`);
    }
    seen.add(key);
  }
}

function assertLedgerFingerprints(ledger: ClipTaskReviewLedger): void {
  assertUniqueFingerprints(ledger.legacyFingerprints, 'legacyFingerprints');
  for (const [index, review] of ledger.reviews.entries()) {
    if (review == null || typeof review !== 'object') {
      throw new ClipTaskReviewLedgerError(`reviews[${index}] must be an object`);
    }
  }
  const reviewFingerprints = ledger.reviews.map((review) => review.fingerprint);
  assertUniqueFingerprints(reviewFingerprints, 'reviews');
  const legacy = new Set(ledger.legacyFingerprints.map((fp) => fp.toLowerCase()));
  for (const fp of reviewFingerprints) {
    if (legacy.has(fp.toLowerCase())) {
      throw new ClipTaskReviewLedgerError(
        `Fingerprint ${fp} appears in both legacyFingerprints and reviews`,
      );
    }
  }
}

function validateReviewEntry(review: unknown, index: number): ClipTaskReviewEntry {
  if (review == null || typeof review !== 'object') {
    throw new ClipTaskReviewLedgerError(`Review at index ${index} must be an object`);
  }
  const entry = review as Record<string, unknown>;
  const prefix = `Review at index ${index}`;

  if (!isSha256Hex(entry.fingerprint)) {
    throw new ClipTaskReviewLedgerError(`${prefix} has a malformed fingerprint hash`);
  }
  if (!isNonEmptyString(entry.clipSlug)) {
    throw new ClipTaskReviewLedgerError(`${prefix} requires a non-empty clipSlug`);
  }
  if (entry.role !== 'prompt' && entry.role !== 'context') {
    throw new ClipTaskReviewLedgerError(`${prefix} role must be prompt or context`);
  }
  if (entry.decision !== 'approved' && entry.decision !== 'rejected') {
    throw new ClipTaskReviewLedgerError(`${prefix} decision must be approved or rejected`);
  }
  if (!TASK_KINDS.includes(entry.taskKind as ClipTaskKind)) {
    throw new ClipTaskReviewLedgerError(`${prefix} taskKind is invalid`);
  }
  if (!isHttpsUrl(entry.sourceUrl)) {
    throw new ClipTaskReviewLedgerError(`${prefix} sourceUrl must be an https URL`);
  }
  if (!isFiniteSeconds(entry.sourceStartSeconds) || !isFiniteSeconds(entry.sourceEndSeconds)) {
    throw new ClipTaskReviewLedgerError(`${prefix} source window seconds must be finite numbers`);
  }
  if (entry.sourceStartSeconds < 0 || entry.sourceEndSeconds <= entry.sourceStartSeconds) {
    throw new ClipTaskReviewLedgerError(`${prefix} sourceEndSeconds must exceed sourceStartSeconds`);
  }
  if (!isFiniteSeconds(entry.evidenceStartSeconds) || !isFiniteSeconds(entry.evidenceEndSeconds)) {
    throw new ClipTaskReviewLedgerError(`${prefix} evidence window seconds must be finite numbers`);
  }
  if (entry.evidenceStartSeconds < 0 || entry.evidenceEndSeconds < 0) {
    throw new ClipTaskReviewLedgerError(`${prefix} evidence window seconds must be non-negative`);
  }
  if (entry.evidenceEndSeconds <= entry.evidenceStartSeconds) {
    throw new ClipTaskReviewLedgerError(`${prefix} evidenceEndSeconds must exceed evidenceStartSeconds`);
  }

  const clipDuration = entry.sourceEndSeconds - entry.sourceStartSeconds;
  if (entry.evidenceEndSeconds > clipDuration) {
    throw new ClipTaskReviewLedgerError(`${prefix} evidence window exceeds source clip duration`);
  }

  if (!isNonEmptyString(entry.reviewedAt) || !Number.isFinite(Date.parse(entry.reviewedAt))) {
    throw new ClipTaskReviewLedgerError(`${prefix} reviewedAt must be a valid ISO date string`);
  }
  if (!isSha256Hex(entry.mediaSha256)) {
    throw new ClipTaskReviewLedgerError(`${prefix} has a malformed mediaSha256 hash`);
  }

  const viewport = entry.viewportEvidence;
  if (viewport == null || typeof viewport !== 'object') {
    throw new ClipTaskReviewLedgerError(`${prefix} viewportEvidence must be an object`);
  }
  const viewportRecord = viewport as Record<string, unknown>;
  if (!isNonEmptyString(viewportRecord.laptop) || !isNonEmptyString(viewportRecord.phone)) {
    throw new ClipTaskReviewLedgerError(`${prefix} viewportEvidence laptop and phone must be non-empty`);
  }

  const role = entry.role as ClipTaskReviewRole;
  const taskKind = entry.taskKind as ClipTaskKind;
  if (role === 'prompt' && taskKind === 'teaching-demonstration') {
    throw new ClipTaskReviewLedgerError(`${prefix} rejects prompt cards with teaching-demonstration taskKind`);
  }

  const visibleEvidence = entry.visibleEvidence;
  if (typeof visibleEvidence !== 'string') {
    throw new ClipTaskReviewLedgerError(`${prefix} visibleEvidence must be a string`);
  }
  if (role === 'context' && visibleEvidence.trim().length === 0) {
    throw new ClipTaskReviewLedgerError(`${prefix} context tasks require non-empty visibleEvidence`);
  }

  if (entry.decision === 'approved') {
    if (visibleEvidence.trim().length === 0) {
      throw new ClipTaskReviewLedgerError(`${prefix} approved reviews require non-empty visibleEvidence`);
    }
    for (const key of SUBSTANTIVE_REVIEW_TEXT_KEYS) {
      if (!isNonEmptyString(entry[key])) {
        throw new ClipTaskReviewLedgerError(`${prefix} approved reviews require non-empty ${key}`);
      }
    }
  }

  return {
    fingerprint: entry.fingerprint.toLowerCase(),
    clipSlug: entry.clipSlug.trim(),
    role,
    decision: entry.decision as ClipTaskReviewDecision,
    taskKind,
    sourceUrl: entry.sourceUrl.trim(),
    sourceStartSeconds: entry.sourceStartSeconds,
    sourceEndSeconds: entry.sourceEndSeconds,
    evidenceStartSeconds: entry.evidenceStartSeconds,
    evidenceEndSeconds: entry.evidenceEndSeconds,
    visibleEvidence,
    targetOrientation: String(entry.targetOrientation ?? ''),
    closestAlternative: String(entry.closestAlternative ?? ''),
    distinction: String(entry.distinction ?? ''),
    videoBenefit: String(entry.videoBenefit ?? ''),
    postRevealTeaching: String(entry.postRevealTeaching ?? ''),
    reviewedAt: entry.reviewedAt,
    mediaSha256: entry.mediaSha256.toLowerCase(),
    viewportEvidence: {
      laptop: String(viewportRecord.laptop).trim(),
      phone: String(viewportRecord.phone).trim(),
    },
  };
}

function validateLedgerReviews(ledger: ClipTaskReviewLedger): ClipTaskReviewEntry[] {
  return ledger.reviews.map((review, index) => validateReviewEntry(review, index));
}

/** Return every cloze answer, including multi-cloze cards. */
export function answersFromBack(back: string): string[] {
  const answers = [...back.matchAll(/\[([^\]]+)\]/g)]
    .map((match) => match[1].trim())
    .filter((answer) => answer.length > 0);
  return answers.length > 0 ? answers : [back.trim()];
}

/** First cloze blank, retained for callers that need the primary answer. */
export function primaryAnswerFromBack(back: string): string {
  return answersFromBack(back)[0] ?? '';
}

function alphabeticCount(value: string): number {
  const letters = value.match(/[a-z]/gi);
  return letters?.length ?? 0;
}

/** Case-insensitive contiguous phrase match with at least three alphabetic characters. */
export function answerPhraseLeaksInPromptCaption(answer: string, caption: string | null | undefined): boolean {
  const haystack = (caption ?? '').toLowerCase();
  if (haystack.length === 0) return false;
  return answersFromBack(answer).some((phrase) => {
    if (alphabeticCount(phrase) < 3) return false;
    const escaped = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z])${escaped}(?![a-z])`).test(haystack);
  });
}

function finding(
  code: ClipTaskReviewFindingCode,
  message: string,
  fingerprint: string,
  clipSlug: string | null,
): ClipTaskReviewFinding {
  return { code, message, fingerprint, clipSlug };
}

export function validateClipTaskReviews(
  cards: readonly ClipTaskInput[],
  ledger: unknown,
): ClipTaskReviewValidationResult {
  const parsed = parseLedger(ledger);
  assertLedgerFingerprints(parsed);
  const reviews = validateLedgerReviews(parsed);
  const legacy = new Set(parsed.legacyFingerprints.map((fp) => fp.toLowerCase()));

  const reviewsByFingerprint = new Map<string, ClipTaskReviewEntry>();
  for (const review of reviews) {
    reviewsByFingerprint.set(review.fingerprint.toLowerCase(), review);
  }

  const approvedBySlugRole = new Map<string, ClipTaskReviewEntry[]>();
  for (const review of reviews) {
    if (review.decision !== 'approved') continue;
    const key = `${review.clipSlug}\0${review.role}`;
    const bucket = approvedBySlugRole.get(key) ?? [];
    bucket.push(review);
    approvedBySlugRole.set(key, bucket);
  }

  const findings: ClipTaskReviewFinding[] = [];

  for (const card of cards) {
    if (!requiresClipTaskReview(card)) continue;

    const fingerprint = clipTaskFingerprint(card);
    const clipSlug = card.clipSlug?.trim() ?? null;
    const role = clipTaskCardRole(card);

    if (legacy.has(fingerprint.toLowerCase())) {
      continue;
    }

    const matched = reviewsByFingerprint.get(fingerprint.toLowerCase());

    if (!matched) {
      const staleCandidates = (approvedBySlugRole.get(`${clipSlug}\0${role}`) ?? [])
        .filter((review) => review.fingerprint.toLowerCase() !== fingerprint.toLowerCase());
      if (staleCandidates.length > 0) {
        findings.push(finding(
          'stale-review-receipt',
          `Clip task ${clipSlug ?? fingerprint} no longer matches its approved review fingerprint`,
          fingerprint,
          clipSlug,
        ));
      } else {
        findings.push(finding(
          'missing-review',
          `Clip task ${clipSlug ?? fingerprint} has no approved pedagogical review receipt`,
          fingerprint,
          clipSlug,
        ));
      }
      continue;
    }

    if (matched.decision === 'rejected') {
      findings.push(finding(
        'rejected-review',
        `Clip task ${clipSlug ?? fingerprint} has a rejected pedagogical review receipt`,
        fingerprint,
        clipSlug,
      ));
      continue;
    }

    if (matched.clipSlug !== clipSlug) {
      findings.push(finding(
        'clip-slug-mismatch',
        `Review clipSlug ${matched.clipSlug} does not match card clipSlug ${clipSlug ?? '(empty)'}`,
        fingerprint,
        clipSlug,
      ));
    }

    if (matched.role !== role) {
      findings.push(finding(
        'clip-role-mismatch',
        `Review role ${matched.role} does not match card role ${role}`,
        fingerprint,
        clipSlug,
      ));
    }

    if (role === 'prompt' && answerPhraseLeaksInPromptCaption(card.back, card.clipCaption)) {
      const phrase = primaryAnswerFromBack(card.back);
      findings.push(finding(
        'answer-leak-in-prompt-caption',
        `Prompt caption leaks answer phrase "${phrase}"`,
        fingerprint,
        clipSlug,
      ));
    }
  }

  return { findings };
}

/** Resolve the approved receipt for a card after validating ledger structure. */
export function getClipTaskReview(
  card: ClipTaskInput,
  ledger: unknown,
): ClipTaskReviewEntry | null {
  if (!requiresClipTaskReview(card)) return null;
  const parsed = parseLedger(ledger);
  assertLedgerFingerprints(parsed);
  const reviews = validateLedgerReviews(parsed);
  const fingerprint = clipTaskFingerprint(card).toLowerCase();
  const legacy = new Set(parsed.legacyFingerprints.map((fp) => fp.toLowerCase()));
  if (legacy.has(fingerprint)) return null;
  return reviews.find((review) => review.fingerprint === fingerprint) ?? null;
}
