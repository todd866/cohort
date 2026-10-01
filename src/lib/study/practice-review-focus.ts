import { normalizeClinicalThreadText } from '@/lib/knowledge/concept-thread-policy';
import type { PromptFigureView } from '@/lib/practice-exam/prompt-figure';

export const PRACTICE_REVIEW_FOCUS_VERSION = 'practice-review-focus-v1' as const;
export const PRACTICE_REVIEW_FOCUS_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type FocusPriority = 'wrong' | 'unanswered';

export interface PracticeReviewFocusTopic {
  topic: string;
  priority: FocusPriority;
}

export interface PracticeReviewFocusMiss {
  topic: string;
  priority: FocusPriority;
  paperId: string;
  paperTitle: string;
  paperPath: string;
  itemId: string;
  questionNumber: number;
  sourceSubmittedAt: string;
  attemptId: string;
}

export interface PracticeReviewFocus {
  schema: typeof PRACTICE_REVIEW_FOCUS_VERSION;
  version: typeof PRACTICE_REVIEW_FOCUS_VERSION;
  rotation: string;
  submittedAt: string;
  expiresAt: string;
  weakTopics: readonly PracticeReviewFocusTopic[];
  misses?: readonly PracticeReviewFocusMiss[];
}

/** The missed exam question, without its answer key. */
export interface PracticeReviewMissedQuestion {
  stem: string;
  options: readonly string[];
  /** The option this learner chose. It is a wrong answer, never the key. */
  selectedIndex: number;
  promptFigure?: PromptFigureView;
}

export interface PracticeReviewProvenance {
  kind: 'exam-topic-follow-up';
  stage?: 'exact-retest' | 'prerequisite' | 'transfer';
  priority: FocusPriority;
  rotation: string;
  submittedAt: string;
  /** Older validated focus snapshots retain topic priority but have no source identity. */
  source?: {
    paperId: string;
    paperTitle: string;
    paperPath: string;
    itemId: string;
    questionNumber: number;
    sourceSubmittedAt: string;
    attemptId: string;
    missed?: PracticeReviewMissedQuestion;
  };
}

export interface PracticeReviewPaperItem {
  id: string;
  topic: string;
  domain: string;
  task: string;
  answerIndex: number;
  options: readonly string[];
  questionNumber?: number | null;
}

export interface PracticeReviewPaper {
  rotation: string;
  items: readonly PracticeReviewPaperItem[];
  paperId?: string;
  paperTitle?: string;
  paperPath?: string;
}

export interface PracticeReviewPaperReference {
  schema: string;
  paperId: string;
  paperVersion: string;
  itemIds: readonly string[];
  /** Server-assigned submission order, used only when client timestamps tie. */
  reviewFocusSequence?: number;
  paperTitle?: string;
  paperPath?: string;
}

export interface PracticeReviewSubmittedAttempt {
  attemptId?: string;
  paper: unknown;
  answers: unknown;
  submittedAt: unknown;
}

const GENERIC_TOPICS = new Set([
  'acute', 'adolescent', 'adult', 'anatomy', 'basic science', 'boy', 'boys',
  'cah', 'cardiology', 'child', 'children', 'classification', 'clinical',
  'clinical features', 'critical care', 'diagnosis', 'differential',
  'differential diagnosis', 'emergency', 'epidemiology', 'female', 'girl',
  'girls', 'health', 'infant', 'infants', 'infection', 'investigation',
  'management', 'mechanism', 'medicine', 'musculoskeletal', 'neonatal',
  'neonate', 'newborn', 'orthopaedics', 'paam', 'paediatric', 'paediatrics',
  'pathology', 'pathophysiology', 'presentation', 'pwh', 'recall',
  'rheumatology', 'surgical', 'toddler', 'toddlers', 'treatment', 'usmle',
  'usmle step1',
]);

function specificTopic(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeClinicalThreadText(value);
  if (normalized.length < 3 || GENERIC_TOPICS.has(normalized)) return null;
  return normalized;
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validRotation(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** Build the immutable, server-scored focus snapshot at exam submission time. */
export function buildPracticeReviewFocus(
  paper: PracticeReviewPaper,
  answers: readonly (number | null | undefined)[],
  submittedAt: Date | string,
  attemptId = '',
): PracticeReviewFocus | null {
  const submittedDate = submittedAt instanceof Date ? submittedAt : new Date(submittedAt);
  const submittedMs = submittedDate.getTime();
  if (!validRotation(paper.rotation) || !Number.isFinite(submittedMs)) return null;
  const byTopic = new Map<string, FocusPriority>();
  const misses: PracticeReviewFocusMiss[] = [];
  paper.items.forEach((item, index) => {
    const answer = answers[index];
    const isAnswered = Number.isInteger(answer) && (answer as number) >= 0 && (answer as number) < item.options.length;
    const priority: FocusPriority = isAnswered ? 'wrong' : 'unanswered';
    if (isAnswered && answer === item.answerIndex) return;
    const topic = specificTopic(item.topic);
    if (!topic) return;
    const prior = byTopic.get(topic);
    if (!prior || (prior === 'unanswered' && priority === 'wrong')) byTopic.set(topic, priority);
    const questionNumber = item.questionNumber;
    if (paper.paperId && paper.paperTitle && paper.paperPath
      && typeof questionNumber === 'number' && Number.isInteger(questionNumber) && questionNumber >= 1 && questionNumber <= 200) {
      misses.push({
        topic,
        priority,
        paperId: paper.paperId,
        paperTitle: paper.paperTitle,
        paperPath: paper.paperPath,
        itemId: item.id,
        questionNumber,
        sourceSubmittedAt: new Date(submittedMs).toISOString(),
        attemptId,
      });
    }
  });
  const topics = [...byTopic.entries()]
    .sort(([left, leftPriority], [right, rightPriority]) => (
      (leftPriority === 'wrong' ? 0 : 1) - (rightPriority === 'wrong' ? 0 : 1)
      || left.localeCompare(right)
    ))
    .map(([topic, priority]) => ({ topic, priority } satisfies PracticeReviewFocusTopic));
  return Object.freeze({
    schema: PRACTICE_REVIEW_FOCUS_VERSION,
    version: PRACTICE_REVIEW_FOCUS_VERSION,
    rotation: paper.rotation,
    submittedAt: new Date(submittedMs).toISOString(),
    expiresAt: new Date(submittedMs + PRACTICE_REVIEW_FOCUS_TTL_MS).toISOString(),
    weakTopics: Object.freeze(topics),
    ...(misses.length > 0 ? { misses: Object.freeze(misses) } : {}),
  });
}

/**
 * Submission-only aggregation: blanks in a partial sitting do not erase an
 * earlier selection. Unknown paper revisions and malformed attempts contribute
 * nothing; every included attempt must describe the same complete item set.
 */
export function buildPracticeReviewFocusFromAttempts(
  paper: PracticeReviewPaper,
  reference: PracticeReviewPaperReference,
  attempts: readonly PracticeReviewSubmittedAttempt[],
  nowMs = Date.now(),
): PracticeReviewFocus | null {
  const items = new Map(paper.items.map((item) => [item.id, item]));
  const matchesItems = (ids: unknown): ids is string[] => Array.isArray(ids)
    && ids.length === items.size
    && new Set(ids).size === items.size
    && ids.every((id) => typeof id === 'string' && items.has(id));
  if (!validTime(nowMs) || !paper.items.length || items.size !== paper.items.length
    || !reference.schema || !reference.paperId || !reference.paperVersion
    || !matchesItems(reference.itemIds)) return null;

  const compatible = attempts.flatMap((attempt) => {
    if (!attempt || !attempt.paper || typeof attempt.paper !== 'object' || Array.isArray(attempt.paper)) return [];
    const saved = attempt.paper as Record<string, unknown>;
    if (saved.schema !== reference.schema || saved.paperId !== reference.paperId
      || saved.paperVersion !== reference.paperVersion || !matchesItems(saved.itemIds)
      || !Array.isArray(attempt.answers) || attempt.answers.length !== items.size) return [];
    const submittedMs = attempt.submittedAt instanceof Date ? attempt.submittedAt.getTime()
      : typeof attempt.submittedAt === 'string' ? Date.parse(attempt.submittedAt) : NaN;
    if (!validTime(submittedMs)) return [];
    const sequence = saved.reviewFocusSequence ?? 0;
    if (!validTime(sequence) || sequence >= Number.MAX_SAFE_INTEGER) return [];
    const selections = new Map<string, number>();
    for (let index = 0; index < saved.itemIds.length; index += 1) {
      const id = saved.itemIds[index];
      const answer: unknown = attempt.answers[index];
      if (answer === null) continue;
      if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer >= items.get(id)!.options.length) return [];
      selections.set(id, answer);
    }
    return [{ submittedMs, sequence, selections, itemIds: saved.itemIds, attemptId: typeof attempt.attemptId === 'string' ? attempt.attemptId : '' }];
  }).sort((left, right) => left.submittedMs - right.submittedMs || left.sequence - right.sequence);
  if (!compatible.length) return null;

  const latest = new Map<string, number>();
  const latestSource = new Map<string, { submittedMs: number; attemptId: string; questionNumber: number }>();
  const explicitlySelected = new Set<string>();
  for (const attempt of compatible) {
    for (const item of paper.items) {
      const answer = attempt.selections.get(item.id);
      const questionNumber = attempt.itemIds.indexOf(item.id) + 1;
      if (answer !== undefined) {
        latest.set(item.id, answer);
        explicitlySelected.add(item.id);
        latestSource.set(item.id, { submittedMs: attempt.submittedMs, attemptId: attempt.attemptId, questionNumber });
      } else if (!explicitlySelected.has(item.id)) {
        latestSource.set(item.id, { submittedMs: attempt.submittedMs, attemptId: attempt.attemptId, questionNumber });
      }
    }
  }
  const sourcedPaper = {
    ...paper,
    paperId: reference.paperId,
    items: paper.items.map((item, index) => ({ ...item, questionNumber: item.questionNumber ?? index + 1 })),
  };
  const focus = buildPracticeReviewFocus(
    sourcedPaper,
    paper.items.map((item) => latest.get(item.id) ?? null),
    new Date(Math.min(compatible[compatible.length - 1].submittedMs, nowMs)),
    '',
  );
  if (!focus?.misses) return focus;
  const misses = focus.misses.map((miss) => {
    const source = latestSource.get(miss.itemId);
    return source ? { ...miss, questionNumber: source.questionNumber, sourceSubmittedAt: new Date(source.submittedMs).toISOString(), attemptId: source.attemptId } : miss;
  });
  return Object.freeze({ ...focus, misses: Object.freeze(misses) });
}

/** Read a stored profile defensively; malformed, stale, or cross-rotation data is ignored. */
export function parsePracticeReviewFocus(
  feedProfile: unknown,
  rotation: string,
  nowMs = Date.now(),
): PracticeReviewFocus | null {
  if (!feedProfile || typeof feedProfile !== 'object' || !validRotation(rotation) || !validTime(nowMs)) return null;
  const stored = (feedProfile as { practiceReviewFocus?: unknown }).practiceReviewFocus;
  const raw = stored && typeof stored === 'object' && !Array.isArray(stored)
    && Object.hasOwn(stored, rotation)
    ? (stored as Record<string, unknown>)[rotation]
    : stored;
  if (!raw || typeof raw !== 'object') return null;
  const focus = raw as Record<string, unknown>;
  const submittedMs = typeof focus.submittedAt === 'string' ? Date.parse(focus.submittedAt) : NaN;
  const expiresMs = typeof focus.expiresAt === 'string' ? Date.parse(focus.expiresAt) : NaN;
  if (focus.schema !== PRACTICE_REVIEW_FOCUS_VERSION || focus.version !== PRACTICE_REVIEW_FOCUS_VERSION || focus.rotation !== rotation
    || !Number.isFinite(submittedMs) || !Number.isFinite(expiresMs)
    || submittedMs > nowMs || expiresMs <= submittedMs || expiresMs <= nowMs
    || expiresMs !== submittedMs + PRACTICE_REVIEW_FOCUS_TTL_MS
    || !Array.isArray(focus.weakTopics)) return null;
  const topics: PracticeReviewFocusTopic[] = [];
  const seen = new Set<string>();
  for (const value of focus.weakTopics) {
    if (!value || typeof value !== 'object') return null;
    const entry = value as Record<string, unknown>;
    const topic = specificTopic(entry.topic);
    if (!topic || seen.has(topic) || (entry.priority !== 'wrong' && entry.priority !== 'unanswered')) return null;
    seen.add(topic);
    topics.push({ topic, priority: entry.priority });
  }
  if (topics.length !== focus.weakTopics.length) return null;
  const submittedAtIso = focus.submittedAt as string;
  const expiresAtIso = focus.expiresAt as string;
  const misses = Array.isArray(focus.misses) ? focus.misses.flatMap((value): PracticeReviewFocusMiss[] => {
    if (!value || typeof value !== 'object') return [];
    const entry = value as Record<string, unknown>;
    const sourceMs = typeof entry.sourceSubmittedAt === 'string' ? Date.parse(entry.sourceSubmittedAt) : NaN;
    if (typeof entry.topic !== 'string' || entry.topic.length > 200 || !specificTopic(entry.topic)
      || (entry.priority !== 'wrong' && entry.priority !== 'unanswered')
      || typeof entry.paperId !== 'string' || entry.paperId.length < 1 || entry.paperId.length > 120 || !/^[a-z0-9-]+$/.test(entry.paperId)
      || typeof entry.itemId !== 'string' || entry.itemId.length < 1 || entry.itemId.length > 80 || !/^[a-z0-9-]+$/.test(entry.itemId)
      || !Number.isFinite(sourceMs) || sourceMs > nowMs
      || typeof entry.attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.attemptId)
      || typeof entry.paperTitle !== 'string' || entry.paperTitle.length < 1 || entry.paperTitle.length > 200
      || typeof entry.paperPath !== 'string' || !/^\/practice-exam\/[a-z0-9-]+\/[a-z0-9-]+$/.test(entry.paperPath)
      || typeof entry.questionNumber !== 'number' || !Number.isInteger(entry.questionNumber) || entry.questionNumber < 1 || entry.questionNumber > 200) return [];
    const paperTitle = entry.paperTitle as string;
    const paperPath = entry.paperPath as string;
    const sourceSubmittedAt = entry.sourceSubmittedAt as string;
    const attemptId = entry.attemptId as string;
    return [{
      topic: specificTopic(entry.topic)!, priority: entry.priority,
      paperId: entry.paperId, itemId: entry.itemId,
      questionNumber: entry.questionNumber,
      sourceSubmittedAt, attemptId,
      paperTitle,
      paperPath,
    }];
  }).slice(0, 200) : [];
  return Object.freeze({
    schema: PRACTICE_REVIEW_FOCUS_VERSION,
    version: PRACTICE_REVIEW_FOCUS_VERSION,
    rotation,
    submittedAt: submittedAtIso,
    expiresAt: expiresAtIso,
    weakTopics: Object.freeze(topics),
    ...(misses.length > 0 ? { misses: Object.freeze(misses) } : {}),
  });
}
