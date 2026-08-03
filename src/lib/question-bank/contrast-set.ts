/**
 * contrast-set — the authoring format that makes "multiple correct answers" affordable.
 *
 * Product requirement: "if you have a 5-answer MCQ with 4 incorrect and one correct, then
 * you need multiple versions of the correct answer to account for pattern recognition"
 * … "and those correct answers may need slightly different question stems."
 *
 * WHY NOT JUST AUTHOR SIBLING MCQs
 * --------------------------------
 * Authoring is the binding constraint, not money. A sibling MCQ costs 5 options, each
 * with an explanation that must survive detectOptionExplanationRestatesText and
 * detectOptionLetterInExplanation, plus its own context and its own guessability pass.
 * Corpus-wide that is ~134k hand-QA'd explanations — not happening, and the shortcut is
 * barred ([[feedback_no_bulk_procedural_imports]], [[feedback_no_external_llm_for_authoring]]).
 *
 * A CONTRAST SET makes the cost linear instead of multiplicative:
 *
 *     N stems  +  K choices (one canonical explanation each)  +  N rationales
 *          …instead of N x 5 options and N x 5 explanations.
 *
 * One shared pool of 5-8 answer choices. N short stems, each pointing at a DIFFERENT
 * choice. The choice explanations are written once and reused across every stem.
 * This provides the same concept space with a different correct answer each
 * encounter, with the stem flexing to make that answer right.
 *
 * WHY IT DEFEATS PATTERN-MATCHING (and a plain paraphrase does not)
 * ---------------------------------------------------------------
 * Rotating the correct answer's WORDING only kills string-matching; a student can still
 * answer by elimination because the four distractors never move. Here the correct answer
 * is a genuinely different fact each time, and with a pool > 5 the option block itself
 * varies per stem — so "this option block means croup" never becomes learnable.
 *
 * EXPANSION HAPPENS AT LOAD TIME, ON PURPOSE
 * ------------------------------------------
 * Every stem materialises into an ordinary CuratedQuestion before validation, so the
 * whole existing quality floor runs on it unchanged: validateCuratedQuestion,
 * checkLengthBias, analyzeGuessability, all 16 flagQuestion detectors, the factual and
 * premortem audits, seeding, embedding. Nothing downstream knows contrast sets exist.
 *
 * This is deliberate. The abandoned display-time rotation (getQuestionOptions'
 * correctVariants) substituted answer text at RENDER, where no validator can see it —
 * which is how 179 questions ended up with variants that made them EASIER (an 8-14 char
 * option set beside a 79-char variant is a screaming length tell). Representation can be
 * linear; semantic verification cannot be skipped.
 *
 * FAMILY KEY
 * ----------
 * Members share `variantGroupId` (the set id) with `variantType: 'contrast-set'`. No
 * migration: variantType is a free-form string column, and the scheduler already serves
 * at most one member of a variantGroupId per session (candidate-ranking.ts:583). The
 * 'contrast-set' marker distinguishes a real family from the 626 legacy groups — of
 * which 443 are topic buckets and 56 are machine dedup clusters, none usable for this.
 * Cross-session rotation needs no new code either: Stage B's freshness ranking floats
 * the never-seen sibling (tier 0) above the seen one.
 *
 * See docs/superpowers/specs/2026-07-16-mcq-answer-rotation-design.md §Stage C.
 */
import { checkLengthBias } from './validate';
import type {
  CuratedQuestion,
  CuratedQuestionOption,
  QuestionDifficulty,
  QuestionType,
  RotationId,
} from './types';

/** One answer choice in the shared pool. Its explanation is authored ONCE. */
export interface ContrastChoice {
  /** Stable slug referenced by stems. */
  key: string;
  /** The option text as rendered. */
  text: string;
  /** Canonical teaching for this choice, reused on every stem that renders it. */
  explanation: string;
}

/** One probe: a stem plus which choice it makes correct. */
export interface ContrastStem {
  /** Stable slug; becomes the question id suffix. */
  key: string;
  stem: string;
  /** Key of the choice that is correct FOR THIS STEM. */
  correct: string;
  /** Why this choice and not its neighbours, here. Becomes the question's context. */
  rationale: string;
}

export interface ContrastSet {
  /** A normal bank id; also the family's variantGroupId. e.g. bank:cah:stridor:v1 */
  id: string;
  sourceFile?: string;
  rotation: RotationId;
  week?: number;
  topics: string[];
  questionType: QuestionType;
  difficulty: QuestionDifficulty;
  cite?: string | null;
  /** 5-8 choices. Every stem renders 5 of them. */
  choices: ContrastChoice[];
  /** >= 2 stems, each with a DISTINCT correct choice. */
  stems: ContrastStem[];
}

export const CONTRAST_SET_VARIANT_TYPE = 'contrast-set';

const MIN_CHOICES = 5;
const MAX_CHOICES = 8;
const OPTIONS_PER_QUESTION = 5;
const MIN_STEMS = 2;
const MIN_EXPLANATION_CHARS = 20;
const MIN_RATIONALE_CHARS = 40;
/**
 * Max ratio between the mean length of stem-correct choices and of never-correct ones.
 *
 * A shared pool is largely SELF-BALANCING against the classic length tell: every choice
 * that a stem makes correct also serves as a distractor in the other stems, so "pick the
 * longest" pays off at chance. The residual risk is narrower — choices that are never
 * correct in ANY stem are pure distractors, and if the correct ones are systematically
 * longer than those, "pick the long one" starts to pay across the whole family.
 *
 * Per-question checkLengthBias (validate.ts:287) cannot see this: inside a single
 * rendered option set the imbalance looks like an ordinary long answer. When every
 * choice takes a turn being correct there are no pure distractors and this cannot fire.
 */
const MAX_CORRECT_VS_DISTRACTOR_LENGTH_RATIO = 1.5;

/**
 * Structural + anti-tell validation, at the SET level.
 *
 * The expanded questions are additionally validated as ordinary questions downstream;
 * these checks exist so a pool-level defect is reported against the pool rather than
 * appearing as five mysterious failures on generated ids.
 */
export function validateContrastSet(set: ContrastSet): string[] {
  const errors: string[] = [];
  const where = set.id || '(missing id)';

  if (!set.id) errors.push('contrast set is missing an id');

  if (set.choices.length < MIN_CHOICES || set.choices.length > MAX_CHOICES) {
    errors.push(
      `${where}: needs ${MIN_CHOICES}-${MAX_CHOICES} choices, has ${set.choices.length}`
    );
  }
  if (set.stems.length < MIN_STEMS) {
    errors.push(`${where}: needs at least ${MIN_STEMS} stems, has ${set.stems.length}`);
  }

  const choiceKeys = new Set<string>();
  for (const c of set.choices) {
    if (choiceKeys.has(c.key)) errors.push(`${where}: duplicate choice key "${c.key}"`);
    choiceKeys.add(c.key);
    if ((c.explanation ?? '').trim().length < MIN_EXPLANATION_CHARS) {
      errors.push(
        `${where}: choice "${c.key}" explanation is under ${MIN_EXPLANATION_CHARS} chars — every rendered option needs real feedback`
      );
    }
    if (!c.text?.trim()) errors.push(`${where}: choice "${c.key}" has no text`);
  }

  const stemKeys = new Set<string>();
  const correctKeys = new Set<string>();
  for (const s of set.stems) {
    if (stemKeys.has(s.key)) errors.push(`${where}: duplicate stem key "${s.key}"`);
    stemKeys.add(s.key);

    if (!choiceKeys.has(s.correct)) {
      errors.push(`${where}: stem "${s.key}" marks "${s.correct}" correct, which is not a choice key`);
    }
    // THE defining invariant: the point of the format is a different correct answer
    // each encounter. Two stems sharing one means the pool still maps to one answer.
    if (correctKeys.has(s.correct)) {
      errors.push(
        `${where}: stems "${s.key}" and an earlier stem share the same correct answer "${s.correct}" — each stem must have a distinct correct choice`
      );
    }
    correctKeys.add(s.correct);

    if ((s.rationale ?? '').trim().length < MIN_RATIONALE_CHARS) {
      errors.push(
        `${where}: stem "${s.key}" rationale is under ${MIN_RATIONALE_CHARS} chars — it becomes the question context and must teach`
      );
    }
    if (!s.stem?.trim()) errors.push(`${where}: stem "${s.key}" has no stem text`);
  }

  errors.push(...checkFamilyLengthTell(set, correctKeys, where));

  // Structural errors make expansion unsafe (it throws on an unknown choice key), so
  // only run the rendered-question checks once the shape is sound.
  if (errors.length > 0) return errors;
  errors.push(...checkRenderedLengthTell(set, where));

  return errors;
}

/**
 * Run the REAL per-question length gate over the expanded family.
 *
 * The family-level check above is necessary but NOT sufficient, and the difference is
 * easy to get wrong: a shared pool balances "pick the longest" ACROSS the family, but a
 * student only ever sees ONE member per session (the scheduler serves one per
 * variantGroupId), so within that single rendered question a long correct answer is
 * still a plain giveaway. checkLengthBias is right to flag it.
 *
 * Running it here means the author gets one error naming the offending CHOICE, instead
 * of a mystery failure on a generated id at seed time.
 */
function checkRenderedLengthTell(set: ContrastSet, where: string): string[] {
  const flagged = checkLengthBias(expandContrastSet(set));
  return flagged.map((f) => {
    const stemKey = set.stems.find((s) => questionIdFor(set.id, s.key) === f.id)?.key ?? f.id;
    const choice = set.choices.find((c) => c.key === set.stems.find((s) => s.key === stemKey)?.correct);
    return (
      `${where}: stem "${stemKey}" renders its correct choice "${choice?.key ?? '?'}" as the ${f.bias} option ` +
      `(${f.correctLen} vs ${f.bias === 'longest' ? f.maxOtherLen : f.minOtherLen} chars) — balance the choice pool; ` +
      `a shared pool does NOT hide this, because a student sees only one stem per session`
    );
  });
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** See MAX_CORRECT_VS_DISTRACTOR_LENGTH_RATIO. */
function checkFamilyLengthTell(set: ContrastSet, correctKeys: Set<string>, where: string): string[] {
  const len = (c: ContrastChoice) => (c.text ?? '').trim().length;
  const correct = set.choices.filter((c) => correctKeys.has(c.key)).map(len).filter((n) => n > 0);
  const pureDistractors = set.choices.filter((c) => !correctKeys.has(c.key)).map(len).filter((n) => n > 0);

  // Every choice takes a turn being correct → balanced by construction.
  if (correct.length === 0 || pureDistractors.length === 0) return [];

  const ratio = mean(correct) / mean(pureDistractors);
  if (ratio > MAX_CORRECT_VS_DISTRACTOR_LENGTH_RATIO) {
    return [
      `${where}: correct choices average ${mean(correct).toFixed(0)} chars vs ${mean(pureDistractors).toFixed(0)} for the never-correct ones (${ratio.toFixed(1)}x) — a length tell across the whole family; lengthen the distractors or shorten the answers`,
    ];
  }
  if (1 / ratio > MAX_CORRECT_VS_DISTRACTOR_LENGTH_RATIO) {
    return [
      `${where}: correct choices average ${mean(correct).toFixed(0)} chars vs ${mean(pureDistractors).toFixed(0)} for the never-correct ones — systematically SHORTER is equally a tell`,
    ];
  }
  return [];
}

/** Rotate an array left by n (n may exceed length). */
function rotate<T>(items: T[], n: number): T[] {
  if (items.length === 0) return items;
  const k = ((n % items.length) + items.length) % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

/**
 * Expand a contrast set into ordinary questions — one per stem.
 *
 * Deterministic: the same set produces byte-identical questions on every seed, so
 * re-seeding never churns ids or orphans progress.
 *
 * Distractors rotate per stem index, so with a pool larger than 5 each stem shows a
 * different option block. Option ORDER here is irrelevant — getQuestionOptions shuffles
 * at render — but the option SET is what stops the block itself becoming the tell.
 */
export function expandContrastSet(set: ContrastSet, sourceFile?: string): CuratedQuestion[] {
  const byKey = new Map(set.choices.map((c) => [c.key, c]));

  return set.stems.map((stem, i) => {
    const correct = byKey.get(stem.correct);
    if (!correct) {
      throw new Error(
        `${set.id}: stem "${stem.key}" marks unknown choice "${stem.correct}" correct — run validateContrastSet first`
      );
    }

    const others = set.choices.filter((c) => c.key !== stem.correct);
    const distractors = rotate(others, i).slice(0, OPTIONS_PER_QUESTION - 1);

    const options: CuratedQuestionOption[] = [correct, ...distractors].map((c, idx) => ({
      label: String.fromCharCode(65 + idx),
      text: c.text,
      isCorrect: c.key === stem.correct,
      // Authored once on the choice, reused on every stem — the linear-cost property.
      explanation: c.explanation,
    }));

    return {
      id: questionIdFor(set.id, stem.key),
      sourceFile: sourceFile ?? set.sourceFile,
      rotation: set.rotation,
      week: set.week,
      topics: set.topics,
      questionType: set.questionType,
      difficulty: set.difficulty,
      stem: stem.stem,
      options,
      // The discriminating teaching lives in context, per .claude/rules/card-quality.md.
      context: stem.rationale,
      cite: set.cite ?? null,
      variantGroupId: set.id,
      variantType: CONTRAST_SET_VARIANT_TYPE,
    } as CuratedQuestion;
  });
}

/** `bank:cah:stridor:v1` + `croup` → `bank:cah:stridor-croup:v1`. */
export function questionIdFor(setId: string, stemKey: string): string {
  const m = setId.match(/^(.*):v(\d+)$/);
  return m ? `${m[1]}-${stemKey}:v${m[2]}` : `${setId}-${stemKey}`;
}
