/**
 * A bedside calculator for dose and fluid questions.
 *
 * Asked for on 2026-10-01, on a 36 kg maintenance-plus-deficit item: "we could
 * just build a calculator into it to save me pulling up the calculator". The
 * arithmetic is the part of these questions nobody needs to practise; reading
 * the guide and choosing the right terms is.
 *
 * A recursive-descent parser over + - * / and parentheses. No eval, no
 * Function: the input is typed by a learner, so it is parsed, never executed.
 */

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string };

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  const src = input.replace(/[x×]/gi, '*').replace(/÷/g, '/');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ('+-*/()'.includes(ch)) { tokens.push({ kind: 'op', value: ch }); i++; continue; }
    const match = /^\d+(?:\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (!match) return null;
    tokens.push({ kind: 'num', value: Number(match[0]) });
    i += match[0].length;
  }
  return tokens;
}

/** The value of a plain arithmetic expression, or null if it is not one. */
export function evaluateArithmetic(input: string): number | null {
  const parsed = tokenize(input);
  if (!parsed || parsed.length === 0) return null;
  const tokens: Token[] = parsed;
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => peek()?.kind === 'op' && peek()?.value === value;

  function primary(): number {
    if (isOp('-')) { pos++; return -primary(); }
    if (isOp('+')) { pos++; return primary(); }
    if (isOp('(')) {
      pos++;
      const value = sum();
      if (!isOp(')')) throw new Error('unclosed');
      pos++;
      return value;
    }
    const token = peek();
    if (token?.kind !== 'num') throw new Error('expected number');
    pos++;
    return token.value;
  }
  function product(): number {
    let value = primary();
    while (isOp('*') || isOp('/')) {
      const op = (tokens[pos++] as { value: string }).value;
      const right = primary();
      if (op === '/' && right === 0) throw new Error('divide by zero');
      value = op === '*' ? value * right : value / right;
    }
    return value;
  }
  function sum(): number {
    let value = product();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { value: string }).value;
      const right = product();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  try {
    const value = sum();
    return pos === tokens.length && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// A topic that names the sum outright.
const CALCULATION_TOPICS = /^(calculation|dose calculation|drug calculation|fluid calculation)$/i;
// Topics where questions are often, but not always, sums.
const CALCULATION_PRONE_TOPICS = /^(fluids?|maintenance fluids|dosing)$/i;
// Asking for an hourly rate is a sum on its own.
const HOURLY_RATE = /\bhourly rate\b|\bmL\s*\/\s*h(?:our)?\b/i;
// Asking for a dose, volume or rate, or quoting a per-kg dose, is a sum only
// when the stem also gives the weight to work from.
const ASKS_FOR_AMOUNT = /\b(mg|mcg|microgram|mL|units?)\s*\/\s*kg\b|\bwhat (?:dose|volume|rate)\b/i;
const STATES_WEIGHT = /\b\d+(?:\.\d+)?\s*-?\s*(?:kg|kilograms?)\b(?!\s*\/)|\bweigh(?:s|ing)\b/i;

/**
 * Whether a review item is the kind of question where a calculator helps: one
 * whose answer is worked out, not recalled. "What dose of folic acid?" is
 * recall, and a 30 mL/kg bolus in the history does not make the vasopressor
 * question a sum.
 */
export function isCalculationItem(item: { type: string; topics?: string[] | null; stem?: string | null }): boolean {
  if (item.type !== 'question') return false;
  const topics = (item.topics ?? []).map((topic) => topic.trim());
  if (topics.some((topic) => CALCULATION_TOPICS.test(topic))) return true;
  const stem = item.stem ?? '';
  if (HOURLY_RATE.test(stem)) return true;
  if (!STATES_WEIGHT.test(stem)) return false;
  return ASKS_FOR_AMOUNT.test(stem) || topics.some((topic) => CALCULATION_PRONE_TOPICS.test(topic));
}
