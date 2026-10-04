/**
 * Statement items: the true/false formats of the surgical selection exams.
 *
 * - `typeX` — RACS GSSE Type X and NSA Type 1: four statements, each judged
 *   true or false independently, one mark each.
 * - `kType` — NSA Type 2: four numbered statements answered with ONE letter
 *   from a fixed key (A = 1 only; B = 2 and 4; C = 1, 2 and 3; D = 4 only;
 *   E = all). Four marks, all or nothing.
 *
 * The format lives in the option shape, not a column: a Type X item's options
 * are its four statements (`statement: true`), a K-type item's options are the
 * five key letters (`fixedKey: true`) and its statements are printed in the
 * stem, exactly as the paper prints them. Everything that already moves
 * options around (seed, session cache, hydration) carries the format for free.
 * See docs/superpowers/specs/2026-10-01-surgical-exam-realism-design.md.
 */

export type ResponseFormat = 'sba' | 'typeX' | 'kType';
export type StatementItemFormat = Exclude<ResponseFormat, 'sba'>;
export type KTypeLetter = 'A' | 'B' | 'C' | 'D' | 'E';

export const K_TYPE_KEY: ReadonlyArray<{
  label: KTypeLetter;
  text: string;
  pattern: readonly [boolean, boolean, boolean, boolean];
}> = [
  { label: 'A', text: '1 only is correct', pattern: [true, false, false, false] },
  { label: 'B', text: '2 and 4 only are correct', pattern: [false, true, false, true] },
  { label: 'C', text: '1, 2 and 3 only are correct', pattern: [true, true, true, false] },
  { label: 'D', text: '4 only is correct', pattern: [false, false, false, true] },
  { label: 'E', text: 'All are correct', pattern: [true, true, true, true] },
];

export interface StatementInput {
  text: string;
  isTrue: boolean;
}

export interface StatementItemOption {
  label: string;
  text: string;
  isCorrect: boolean;
  /** A Type X statement, judged on its own. */
  statement?: true;
  /** A K-type key letter; never shuffled or relabelled. */
  fixedKey?: true;
  explanation?: string;
}

type OptionLike = { label?: unknown; isCorrect?: unknown; statement?: unknown; fixedKey?: unknown };

function samePattern(a: readonly boolean[], b: readonly boolean[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function kTypeLetterFor(truths: readonly boolean[]): KTypeLetter | null {
  return K_TYPE_KEY.find((key) => samePattern(key.pattern, truths))?.label ?? null;
}

function requireFour(statements: readonly StatementInput[]): void {
  if (statements.length !== 4) {
    throw new Error(`A statement item needs exactly four statements (got ${statements.length})`);
  }
}

export function buildStatementItemOptions(
  format: StatementItemFormat,
  statements: readonly StatementInput[],
): StatementItemOption[] {
  requireFour(statements);
  if (format === 'typeX') {
    return statements.map((s, index) => ({
      label: String(index + 1),
      text: s.text,
      isCorrect: s.isTrue,
      statement: true,
    }));
  }
  const letter = kTypeLetterFor(statements.map((s) => s.isTrue));
  if (!letter) {
    throw new Error(
      `K-type truth pattern ${statements.map((s) => (s.isTrue ? 'T' : 'F')).join('')} is not on the answer key`,
    );
  }
  return K_TYPE_KEY.map((key) => ({
    label: key.label,
    text: key.text,
    isCorrect: key.label === letter,
    fixedKey: true,
  }));
}

/** The K-type stem as the NSA paper prints it: the lead-in, then 1–4. */
export function kTypeStem(stem: string, statements: readonly StatementInput[]): string {
  requireFour(statements);
  // A blank line between statements: the stem renderer joins single newlines.
  return `${stem.trim()}\n\n${statements.map((s, index) => `${index + 1}. ${s.text}`).join('\n\n')}`;
}

export function responseFormatOfOptions(options: unknown): ResponseFormat {
  if (!Array.isArray(options) || options.length === 0) return 'sba';
  const rows = options as OptionLike[];
  if (rows.length === 4 && rows.every((o) => o?.statement === true)) return 'typeX';
  if (rows.length === K_TYPE_KEY.length && rows.every((o) => o?.fixedKey === true)) return 'kType';
  return 'sba';
}

/** Four judgements → the `selectedOption` wire string ('TFFT'); null if any is unanswered. */
export function encodeTypeXAnswer(judgements: ReadonlyArray<boolean | null>): string | null {
  if (judgements.length !== 4 || judgements.some((j) => j === null)) return null;
  return judgements.map((j) => (j ? 'T' : 'F')).join('');
}

export interface TypeXGrade {
  marks: number;
  maxMarks: 4;
  isCorrect: boolean;
  /** The key as a wire string, e.g. 'TFFT'. */
  correctOption: string;
  /** Zero-based indexes of statements judged wrongly. */
  missed: number[];
}

/** Null when the options are not a Type X set or the answer is malformed — never a guess. */
export function gradeTypeX(options: unknown, answer: string): TypeXGrade | null {
  if (responseFormatOfOptions(options) !== 'typeX') return null;
  const normalized = answer.trim().toUpperCase();
  if (!/^[TF]{4}$/.test(normalized)) return null;
  const truths = (options as OptionLike[]).map((o) => o.isCorrect === true);
  const missed = truths.flatMap((truth, index) => ((normalized[index] === 'T') === truth ? [] : [index]));
  return {
    marks: 4 - missed.length,
    maxMarks: 4,
    isCorrect: missed.length === 0,
    correctOption: truths.map((t) => (t ? 'T' : 'F')).join(''),
    missed,
  };
}

/**
 * The bank's spelling of a fact key: each `|` part trimmed, lower-cased and
 * whitespace-collapsed. Question.statements stores this form; anything matched
 * against it (a scaffold card's topics, say) must be normalised the same way.
 */
export function normaliseFactKey(key: string): string {
  return key.split('|').map((part) => part.trim().toLowerCase().replace(/\s+/g, ' ')).join('|');
}

/**
 * The statements a K-type answer got wrong: those whose truth the chosen
 * letter's pattern misstates. A skip or unknown letter misses all four — the
 * learner committed to nothing, so every statement is worth teaching.
 */
export function missedStatementsForKType(truths: readonly boolean[], chosen: string | null): number[] {
  const key = chosen === null ? undefined : K_TYPE_KEY.find((k) => k.label === chosen.trim().toUpperCase());
  if (!key) return truths.map((_, index) => index);
  return truths.flatMap((truth, index) => (key.pattern[index] === truth ? [] : [index]));
}
