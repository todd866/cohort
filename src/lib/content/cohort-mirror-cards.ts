/**
 * Increment 3 of docs/designs/2026-09-23-cohort-mirror.md: md3's CARDS into
 * Cohort. Pure rules; the generator (scripts/content/cohort-mirror-cards.ts)
 * reads the files and the ledgers and hands the evidence in.
 *
 * Owner, 2026-09-23: a CARD publishes on rights-clean + factual-audit-clean,
 * with a grounding badge where one exists. So, unlike a question, a card needs
 * no guideline citation; when it has a verified one, the public copy carries it
 * as a reference.
 *
 * Rights, as for questions, decides whether an item ships at all; USyd
 * structure decides only labelling, so headings, weeks, rotations, cluster ids
 * and authored variant-group names are all dropped rather than filtered. A
 * filter on known spellings fails open on the next unknown one.
 */
import { createHash } from 'node:crypto';

import type { GeneratedCard } from '@/lib/card-generator';
import { classifyCardProvenance } from './rights-provenance';
import {
  assignDiscipline,
  COHORT_DISCIPLINES,
  COHORT_MODULE_ROTATION,
  sharedWordRuns,
  usydCourseMarkers,
  type CohortDiscipline,
} from './cohort-mirror';

export { COHORT_MODULE_ROTATION };

const BLANK = '[___]';
const DISCIPLINES: ReadonlySet<string> = new Set(COHORT_DISCIPLINES);

/** USyd's KAT exam-prep decks: USyd assessment material, a RIGHTS exclusion. */
const ASSESSMENT_ROTATIONS: ReadonlySet<string> = new Set(['year1-kat1', 'year2-kat5', 'year2-kat7']);
/** A heading that says the card reproduces an assessment item. */
const ASSESSMENT_HEADING = /\bKAT\s?\d?\b|practice (?:exam|paper|questions)|\bquiz\b|grand round questions/i;

/**
 * Card-only screens on top of the shared course markers. Cards carry teaching
 * prose, which is where local logistics and "as the lecture said" turn up.
 * Each one withholds; nothing is rewritten.
 */
const LOCAL_HOSPITAL = /\b(?:RPAH?|Royal Prince Alfred|Westmead|Concord Hospital|Nepean|Royal North Shore|RNSH|Liverpool Hospital|Blacktown Hospital|CHW|Sydney Children's Hospital)\b/;
const COURSE_REFERENCE = /\b(?:lecture[rs]?|tutorials?|tutor|this rotation|your rotation|this term|your term|this block|your block|the rotation)\b/i;
/**
 * A note about how the LEARNER did, not about the medicine: "got this wrong on
 * the quiz", "a 0.4/1 matching question". Personal study data, and it describes
 * an assessment item. Found by an independent read on 2026-10-01, after every
 * name screen had passed.
 */
const PERSONAL_ASSESSMENT_NOTE = /\bgot (?:this|it) wrong\b|\bmatching question\b|\bthis was a \d|\b(?:this|the) question asks\b|\bOUR patient\b|\bthe quiz\b|\bmarks in the\b/i;
/** An entity left escaped by extraction (`P/F &lt150` became the answer `&lt`). `U&E` is not one. */
const BROKEN_ENTITY = /&(?:lt|gt|amp|nbsp|quot|#\d+)(?:;|\b)/;
/** Wording that only makes sense with the picture in front of you. */
const POINTS_AT_IMAGE = /\b(?:image|picture|photo(?:graph)?|figure|shown|pictured|illustrated|this (?:rash|lesion|x-?ray|film|ECG|trace|scan|radiograph))\b/i;

/** Validator findings the public copy treats as blocking (errors always are). */
export const BLOCKING_QUALITY_WARNINGS: ReadonlyArray<string> = Object.freeze([
  'Bad cloze span selection',
  'Front contains too much of the answer',
  '"One-of-many" cloze',
  'Card has no context',
  'Answer looks like a question',
  'Answer looks like a label',
  'Front references an image',
]);

export type FactualStatus = 'clean' | 'defect' | 'unaudited';

export interface MirrorCardDecisionInput {
  /** One served card, AFTER the variant split, with the stableId the seed gives it. */
  card: GeneratedCard & { stableId: string };
  /** Repo-relative MDX path the card was parsed from. */
  sourcePath: string;
  frontmatterSource: string | null;
  /** The content/modules/<slug>/ folder, when the file lives in the discipline tree. */
  folderDiscipline: string | null;
  /** Blocking card-quality findings (validator errors, blocking warnings, context caps). */
  qualityIssues: string[];
  factual: FactualStatus;
  /** The grounded passage, when the citation layer has one for this card. */
  groundingQuote: string | null;
  isOpenFigure: (path: string) => boolean;
}

export interface MirrorCardDecision {
  publish: boolean;
  discipline: CohortDiscipline | null;
  reasons: string[];
}

const cardText = (card: GeneratedCard): string =>
  [card.front, card.back, ...(card.backs ?? []), card.context ?? '', card.imageCaption ?? ''].join('\n');

/** Whether one md3 card may join Cohort, and every reason it may not. */
export function decideMirrorCard(input: MirrorCardDecisionInput): MirrorCardDecision {
  const { card } = input;
  const reasons: string[] = [];

  const rights = classifyCardProvenance({
    stableId: card.stableId,
    rotation: card.rotation,
    sourceFile: card.sourceFile ?? null,
    context: card.context ?? null,
    sourcePath: input.sourcePath,
    frontmatterSource: input.frontmatterSource,
  });
  if (rights.provenance === 'import') reasons.push(`import: ${rights.reason}`);
  if (ASSESSMENT_ROTATIONS.has(card.rotation) || card.topics.some((t) => ASSESSMENT_HEADING.test(t))) {
    reasons.push('USyd assessment material');
  }

  const folder = input.folderDiscipline && DISCIPLINES.has(input.folderDiscipline)
    ? (input.folderDiscipline as CohortDiscipline) : null;
  const discipline = folder ?? assignDiscipline({
    modulesAttr: (card.moduleNodes ?? []).map((n) => n.split('/').pop()).join(','),
    rotation: card.rotation,
  }).discipline;
  if (!discipline) reasons.push('no discipline');

  if (card.cardType !== 'cloze' || card.front.split(BLANK).length !== 2 || (card.backs?.length ?? 0) > 1 || !card.back.trim()) {
    reasons.push('not a single-blank cloze');
  }
  if (input.qualityIssues.length > 0) reasons.push(`card quality: ${input.qualityIssues[0]}`);

  const text = cardText(card);
  const markers = usydCourseMarkers(text);
  if (markers.length) reasons.push(`USyd marker: ${markers.join('+')}`);
  if (LOCAL_HOSPITAL.test(text)) reasons.push('local hospital reference');
  if (COURSE_REFERENCE.test(text)) reasons.push('course reference');
  if (PERSONAL_ASSESSMENT_NOTE.test(text)) reasons.push('personal assessment note');
  if (BROKEN_ENTITY.test(text)) reasons.push('broken HTML entity');

  if (card.clipSlug) reasons.push('carries a video clip');
  if (card.imageUrl && !input.isOpenFigure(card.imageUrl)) {
    if (card.imageRole === 'prompt') reasons.push('image is the prompt and not an open original');
    else if (POINTS_AT_IMAGE.test(`${card.front}\n${card.back}\n${card.context ?? ''}`)) {
      reasons.push('text refers to an image that cannot ship');
    }
  }

  if (input.factual === 'defect') reasons.push('factual audit: confirmed defect');
  if (input.factual === 'unaudited') reasons.push('factual audit: not audited at this wording');

  if (input.groundingQuote && sharedWordRuns(text, input.groundingQuote) > 0) {
    reasons.push('verbatim 8-word run from the grounded passage');
  }

  return { publish: reasons.length === 0, discipline, reasons };
}

/** One factual-audit ledger row, reduced to what the decision needs. */
export interface FactualLedgerRow {
  model: string;
  auditedAt: string;
  verdict: string;
  auDecision?: string;
}

/**
 * The factual state of a card's CURRENT wording. The ledger is keyed by a hash
 * of front/back/backs/context, so an edit after an audit leaves the card
 * unaudited, never clean. The latest verdict per model wins (the ledger's own
 * read rule); any model's confirmed defect is a defect. The grounded-citation
 * layer's `contradicts` is a defect too, unless a judge ruled the card right
 * for Australian practice (`auDecision: keep`). `isDefect` is the audit's own
 * predicate, injected so the rule has one copy.
 */
export function factualStatusFor<R extends FactualLedgerRow>(
  rowsAtHash: readonly R[],
  contradicted: boolean,
  isDefect: (row: R) => boolean,
): FactualStatus {
  if (rowsAtHash.length === 0) return 'unaudited';
  const latest = new Map<string, R>();
  for (const row of rowsAtHash) {
    const prior = latest.get(row.model);
    if (!prior || row.auditedAt >= prior.auditedAt) latest.set(row.model, row);
  }
  const current = [...latest.values()];
  if (current.some(isDefect)) return 'defect';
  if (contradicted && !current.some((row) => row.auDecision === 'keep')) return 'defect';
  return 'clean';
}

export interface PublicCardReference { title: string; publisher: string | null; url: string }

export interface PublicMirrorCard {
  /** Opaque public id; also the seeded Card.stableId. */
  id: string;
  /** The md3 stableId it was generated from: a trace, never an id. */
  origin: string;
  discipline: CohortDiscipline;
  cardType: 'cloze';
  sourceComponent: GeneratedCard['sourceComponent'];
  front: string;
  back: string;
  context: string | null;
  complexity: number;
  importance: 1 | 2 | 3;
  /** Siblings that test the same fact share this key; the host serves one per session. */
  variantGroup: string | null;
  variantIndex: number | null;
  imageUrl?: string;
  imageCaption?: string;
  /** The grounding badge: a verified guideline the card agrees with. Cited, never quoted. */
  reference: PublicCardReference | null;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const OPAQUE_STABLE_ID = /^mdx:[0-9a-f]{32}(?::blank-\d+)?$/;

export function toPublicCard(
  card: GeneratedCard & { stableId: string },
  discipline: CohortDiscipline,
  options: { isOpenFigure: (path: string) => boolean; reference?: PublicCardReference | null },
): PublicMirrorCard {
  const openImage = card.imageUrl && options.isOpenFigure(card.imageUrl) ? card.imageUrl : null;
  return {
    id: `cohort:${discipline}:c-${sha(card.stableId).slice(0, 12)}:v1`,
    origin: OPAQUE_STABLE_ID.test(card.stableId) ? card.stableId : `md3:${sha(card.stableId).slice(0, 16)}`,
    discipline,
    cardType: 'cloze',
    sourceComponent: card.sourceComponent,
    front: card.front,
    back: card.back,
    context: card.context?.trim() ? card.context : null,
    complexity: card.complexity,
    importance: card.importance ?? 2,
    // The authored group name can carry course structure (`cah-kawasaki-...`).
    variantGroup: card.variantGroupId ? `cohort:${discipline}:g-${sha(card.variantGroupId).slice(0, 12)}` : null,
    variantIndex: card.variantGroupId ? card.variantIndex ?? null : null,
    ...(openImage ? { imageUrl: openImage, ...(card.imageCaption ? { imageCaption: card.imageCaption } : {}) } : {}),
    reference: options.reference ?? null,
  };
}

/**
 * An independent review of one public card's exact wording. Measured
 * 2026-10-01: an independent read of 60 audit-clean cards found a defect in 16
 * (a wrong posture, a pre-Sepsis-3 definition, withdrawn hypotonic fluids). The
 * owner's rule publishes audit-clean cards without a review, so the ledger is a
 * DENY list: a `needs-fix` at the current wording withholds the card, and an
 * edit to the md3 card (which must then be re-audited) lifts it.
 */
export interface CardReview {
  verdict: 'passed' | 'needs-fix';
  contentHash: string;
  reviewer: string;
  reviewedAt: string;
  category?: string;
  detail?: string;
}
export type CardReviewLedger = Readonly<Record<string, CardReview>>;

/** sha256 of everything a learner reads on the public card. */
export function publicCardContentHash(card: PublicMirrorCard): string {
  const read = {
    front: card.front, back: card.back, context: card.context,
    imageCaption: card.imageCaption ?? null, reference: card.reference,
  };
  return sha(JSON.stringify(read));
}

export function cardReviewWithholds(card: PublicMirrorCard, ledger: CardReviewLedger): boolean {
  const review = ledger[card.id];
  return review?.verdict === 'needs-fix' && review.contentHash === publicCardContentHash(card);
}

/** What a reviewer returns: every defect found, and every id it actually read. */
export interface CardReviewerOutput {
  defects: Array<{ id: string; category: string; detail: string }>;
  read: string[];
}

/**
 * Fold one reviewer's output into the ledger. An id the reviewer did not list
 * as read stays unreviewed, never clean; a later pass never clears a
 * `needs-fix` recorded at the same wording (only an edit does).
 */
export function applyCardReview(
  ledger: CardReviewLedger,
  cards: readonly PublicMirrorCard[],
  output: CardReviewerOutput,
  meta: { reviewer: string; reviewedAt: string },
): Record<string, CardReview> {
  const next: Record<string, CardReview> = { ...ledger };
  const byId = new Map(cards.map((card) => [card.id, card]));
  const flagged = new Set<string>();
  for (const defect of output.defects) {
    const card = byId.get(defect.id);
    if (!card) continue;
    flagged.add(card.id);
    next[card.id] = {
      verdict: 'needs-fix', contentHash: publicCardContentHash(card), ...meta,
      category: defect.category, detail: defect.detail,
    };
  }
  for (const id of output.read) {
    const card = byId.get(id);
    if (!card || flagged.has(id)) continue;
    const hash = publicCardContentHash(card);
    const prior = next[id];
    if (prior?.verdict === 'needs-fix' && prior.contentHash === hash) continue;
    next[id] = { verdict: 'passed', contentHash: hash, ...meta };
  }
  return Object.fromEntries(Object.entries(next).sort(([x], [y]) => x.localeCompare(y)));
}

const PUBLIC_ID = /^cohort:([a-z-]+):c-[0-9a-f]{12}:v1$/;
const PUBLIC_GROUP = /^cohort:([a-z-]+):g-[0-9a-f]{12}$/;
const PUBLIC_ORIGIN = /^(?:mdx:[0-9a-f]{32}(?::blank-\d+)?|md3:[0-9a-f]{16})$/;
const ROTATION_TOKEN = /\b(?:PAAM|PWH|year3-common|year[12]-kat\d|critical-care-week|[a-z]+-cluster-\d+|cluster-\d+)\b/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * What a stranger could learn about md3's course or its people from one public
 * card. Run on every generated card (the build refuses to write a leak) and,
 * by the committed-files test, on every card that shipped.
 */
export function publicCardLeaks(card: PublicMirrorCard): string[] {
  const leaks: string[] = [];
  const idDiscipline = PUBLIC_ID.exec(card.id)?.[1];
  if (!idDiscipline || idDiscipline !== card.discipline || !DISCIPLINES.has(card.discipline)) leaks.push(`id ${card.id}`);
  if (!PUBLIC_ORIGIN.test(card.origin)) leaks.push(`origin ${card.origin}`);
  if (card.variantGroup !== null && PUBLIC_GROUP.exec(card.variantGroup)?.[1] !== card.discipline) leaks.push(`variantGroup ${card.variantGroup}`);
  const text = [card.front, card.back, card.context ?? '', card.imageCaption ?? '', card.reference?.title ?? ''].join('\n');
  for (const marker of usydCourseMarkers(text)) leaks.push(`course marker ${marker}`);
  if (ROTATION_TOKEN.test(text)) leaks.push(`rotation or cluster token ${ROTATION_TOKEN.exec(text)?.[0]}`);
  if (EMAIL.test(text)) leaks.push('email address');
  if (PERSONAL_ASSESSMENT_NOTE.test(text)) leaks.push('personal assessment note');
  return leaks;
}

export interface CohortCardShard {
  schemaVersion: 1;
  discipline: CohortDiscipline;
  licence: 'CC-BY-4.0';
  attribution: 'MD3 contributors';
  cards: PublicMirrorCard[];
}

export interface CohortCardRelease {
  schemaVersion: 1;
  cardIds: string[];
  /** Serving fingerprint of each seeded row; the Cohort host refuses any row that drifted. */
  cardFingerprints: Record<string, string>;
}

/**
 * Shards are per discipline and per first hex digit of the id hash: at most 16
 * small files a discipline, so no file nears the export's 2 MB cap, a card's
 * file never moves, and a diff touches only the shards whose cards changed.
 */
export function cardShardPath(card: Pick<PublicMirrorCard, 'id' | 'discipline'>): string {
  const hex = /:c-([0-9a-f])/.exec(card.id)?.[1];
  if (!hex) throw new Error(`unexpected public card id ${card.id}`);
  return `open-content/modules/cards/${card.discipline}/${hex}.json`;
}

/** The Card row a public card seeds, as the host reads it back. */
export interface CohortCardServingRow {
  stableId: string;
  rotation: string;
  cardType: string;
  front: string;
  back: string;
  context: string | null;
  imageUrl: string | null;
  imageCaption: string | null;
  moduleNodes: string[];
  variantGroupId: string | null;
  variantIndex: number | null;
}

export function cohortCardServingRow(card: PublicMirrorCard): CohortCardServingRow {
  return {
    stableId: card.id,
    rotation: COHORT_MODULE_ROTATION,
    cardType: card.cardType,
    front: card.front,
    back: card.back,
    context: card.context,
    imageUrl: card.imageUrl ?? null,
    imageCaption: card.imageCaption ?? null,
    moduleNodes: [`cohort/${card.discipline}`],
    variantGroupId: card.variantGroup,
    variantIndex: card.variantIndex,
  };
}

/** sha256 of everything a learner reads from a seeded row, in a fixed field order. */
export function cohortCardServingFingerprint(row: CohortCardServingRow): string {
  const projection = [
    row.stableId, row.rotation, row.cardType, row.front, row.back, row.context ?? null,
    row.imageUrl ?? null, row.imageCaption ?? null, [...row.moduleNodes].sort(),
    row.variantGroupId ?? null, row.variantIndex ?? null,
  ];
  return sha(JSON.stringify(projection));
}

/** Cleared public cards → the committed shard files and the release. Deterministic. */
export function buildCardArtifacts(cards: readonly PublicMirrorCard[]): {
  files: Map<string, CohortCardShard>;
  release: CohortCardRelease;
} {
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.id)) throw new Error(`duplicate public card id ${card.id}`);
    seen.add(card.id);
    const leaks = publicCardLeaks(card);
    if (leaks.length > 0) throw new Error(`public card ${card.id} would leak: ${leaks.join('; ')}`);
  }
  const ordered = [...cards].sort((a, b) => a.id.localeCompare(b.id));
  const files = new Map<string, CohortCardShard>();
  for (const card of ordered) {
    const path = cardShardPath(card);
    const shard = files.get(path) ?? {
      schemaVersion: 1 as const, discipline: card.discipline, licence: 'CC-BY-4.0' as const,
      attribution: 'MD3 contributors' as const, cards: [],
    };
    shard.cards.push(card);
    files.set(path, shard);
  }
  const sortedFiles = new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
  return {
    files: sortedFiles,
    release: {
      schemaVersion: 1,
      cardIds: ordered.map((c) => c.id),
      cardFingerprints: Object.fromEntries(ordered.map((c) => [c.id, cohortCardServingFingerprint(cohortCardServingRow(c))])),
    },
  };
}
