/**
 * Exam gaps: what a learner may record about an exam they sat, and how a
 * stored row is read back. Client-safe (zod only): the form validates with
 * the same schema the API does.
 *
 * The official USyd KAT feedback reports an overall raw score and n/N per
 * blueprint area (docs/exam-results/*.md), so that is the shape. Each area is
 * either a canonical ID from the rotation's taxonomy (the API checks the ID
 * belongs to the rotation) or a custom area with a strictly validated short
 * label: one line of letters, digits, spaces and basic punctuation, no
 * brackets. Custom labels are learner text and are treated as untrusted
 * wherever they travel (docs/SECURITY.md).
 */
import { z } from 'zod';
import { customAreaKey, CUSTOM_AREA_LABEL, CUSTOM_AREA_PREFIX } from './area-keys';
import type { AreaScore, ExamResultView } from './stats-model';

export const EXAM_ROTATIONS = ['critical-care', 'paam', 'cah', 'pwh'] as const;
export const MAX_AREAS = 30;
export const MAX_CUSTOM_LABEL = 60;
export const MAX_RECALLED_CHARS = 4_000;
export const MAX_EXAM_QUESTIONS = 300;

/** Letters, digits, spaces and , . ' & / - only; must start with a letter or digit. */
export { CUSTOM_AREA_LABEL };
const AREA_ID = /^[a-z0-9][a-z0-9.-]{0,79}$/;

const marks = {
  correct: z.number().int().min(0).max(MAX_EXAM_QUESTIONS),
  total: z.number().int().min(1).max(MAX_EXAM_QUESTIONS),
};

const canonicalArea = z.object({ id: z.string().regex(AREA_ID), ...marks }).strict();
const customArea = z.object({
  label: z.string().max(MAX_CUSTOM_LABEL).regex(CUSTOM_AREA_LABEL, 'Area names: letters, numbers and basic punctuation, one line').refine((l) => l.trim() === l, 'no leading or trailing spaces'),
  ...marks,
}).strict();
const areaInput = z.union([canonicalArea, customArea]).refine((a) => a.correct <= a.total, 'correct exceeds total');

const areaKey = (a: z.infer<typeof areaInput>) => ('id' in a ? a.id : customAreaKey(a.label));

export const examResultInputSchema = z.object({
  rotation: z.enum(EXAM_ROTATIONS),
  block: z.number().int().min(1).max(4),
  examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => Number.isFinite(Date.parse(`${d}T00:00:00Z`)), 'invalid date'),
  correct: z.number().int().min(0).max(MAX_EXAM_QUESTIONS),
  total: z.number().int().min(1).max(MAX_EXAM_QUESTIONS),
  areas: z.array(areaInput).max(MAX_AREAS)
    .refine((areas) => new Set(areas.map(areaKey)).size === areas.length, 'an area appears twice'),
  recalled: z.string().max(MAX_RECALLED_CHARS).optional(),
}).strict().refine((r) => r.correct <= r.total, 'correct exceeds total');

export type ExamResultInput = z.infer<typeof examResultInputSchema>;

/** The stored shape: `{ area: <canonical id | custom:label>, correct, total }`. */
export function toStoredAreas(areas: ExamResultInput['areas']): AreaScore[] {
  return areas.map((a) => ({ area: areaKey(a), correct: a.correct, total: a.total }));
}

/**
 * A stored result back in the form the API accepts, so an upload that
 * replaced it can be undone exactly; null when the row cannot round-trip
 * (an older row without raw marks).
 */
export function examViewToInput(view: ExamResultView): ExamResultInput | null {
  const parsed = examResultInputSchema.safeParse({
    rotation: view.rotation,
    block: view.block,
    examDate: view.examDate,
    correct: view.correct,
    total: view.total,
    areas: view.areas.map((a) => (a.area.startsWith(CUSTOM_AREA_PREFIX)
      ? { label: a.area.slice(CUSTOM_AREA_PREFIX.length), correct: a.correct, total: a.total }
      : { id: a.area, correct: a.correct, total: a.total })),
    ...(view.recalled ? { recalled: view.recalled } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** Canonical IDs that are not in the rotation's taxonomy, for the API to refuse. */
export function unknownAreaIds(areas: ExamResultInput['areas'], isCanonical: (id: string) => boolean): string[] {
  return areas.flatMap((a) => ('id' in a && !isCanonical(a.id) ? [a.id] : []));
}

/**
 * The academic block an exam closed, from its date (2026 calendar: exams in
 * March, May, early October, late November). A guess for the form's default
 * only; the learner can change it.
 */
export function blockForDate(iso: string): number {
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (month <= 3) return 1;
  if (month <= 7) return 2;
  if (month < 10 || (month === 10 && day <= 20)) return 3;
  return 4;
}

const storedArea = z.object({ area: z.string().min(1).max(200), ...marks }).refine((a) => a.correct <= a.total);

/**
 * Resolves a stored area key against the row's rotation: a verified
 * canonical ID or a valid `custom:` key, mapping a recognised legacy label to
 * its ID, keeping any other single-line label as custom (untrusted), and
 * dropping the rest. Canonical status is decided only by taxonomy membership.
 */
export type StoredAreaResolver = (rotation: string, key: string) => string | null;

function readAreas(value: unknown, rotation: string, resolve: StoredAreaResolver): AreaScore[] {
  if (!Array.isArray(value)) return [];
  const out: AreaScore[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const parsed = storedArea.safeParse(raw);
    if (!parsed.success) continue;
    const key = resolve(rotation, parsed.data.area);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ area: key, correct: parsed.data.correct, total: parsed.data.total });
  }
  return out;
}

/** A stored ExamResult row, tolerant of rows written by the older recorder script. */
export function toExamResultView(row: {
  id: string;
  rotation: string;
  block: number;
  examDate: Date | string;
  score: number;
  correct?: number | null;
  total?: number | null;
  areas?: unknown;
  recalled?: string | null;
  source?: string | null;
}, resolveArea: StoredAreaResolver): ExamResultView {
  const examDate = row.examDate instanceof Date ? row.examDate.toISOString().slice(0, 10) : String(row.examDate).slice(0, 10);
  return {
    id: row.id,
    rotation: row.rotation,
    block: row.block,
    examDate,
    score: row.score,
    correct: row.correct ?? null,
    total: row.total ?? null,
    areas: readAreas(row.areas, row.rotation, resolveArea),
    recalled: row.recalled?.trim() ? row.recalled : null,
    source: row.source ?? 'script',
  };
}
