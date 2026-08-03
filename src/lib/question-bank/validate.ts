import type { CuratedQuestion, CuratedQuestionOption } from './types';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeLabel(label: string): string {
  return label.trim().toUpperCase();
}

function stripMarkdownTables(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('|'))
    .join('\n')
    .trim();
}

function splitStemParagraphs(stem: string): string[] {
  return stem
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

// Common abbreviations whose internal periods would otherwise be counted as
// sentence boundaries. Keep conservative — only abbreviations we actually see
// in medical exam stems. Decimals (1.5 mmol) are also protected.
const ABBREVIATIONS_WITH_PERIODS = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|approx|cf|e\.g|i\.e|No|Fig|Inc|Co|Ltd|Ave|Blvd|Rd|Ph\.D|M\.D|R\.N|q\.d|b\.i\.d|t\.i\.d|q\.i\.d|p\.r\.n|q\.h\.s|p\.o)\./g;

function countSentences(text: string): number {
  // Mask abbreviation periods + decimal points so they don't count as
  // sentence boundaries.
  const masked = text
    .replace(ABBREVIATIONS_WITH_PERIODS, (m) => m.replace(/\./g, ''))
    .replace(/(\d)\.(\d)/g, '$1$2');
  const normalized = masked.replace(/\s+/g, ' ').trim();
  if (!normalized) return 0;
  const matches = normalized.match(/[.!?](?=\s|$)/g);
  return matches ? matches.length : 1;
}

function containsMarkdownTable(stem: string): boolean {
  return /(^|\n)\|.+\|/m.test(stem);
}

function hasReferenceRangeColumn(stem: string): boolean {
  return stem
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .some((line) => /\b(normal|reference|range)\b/i.test(line));
}

// Lab labels that, when followed by a numeric value, count as a "lab with
// value" toward the lab-heavy detector. Context markers (ABG/VBG/blood gas)
// don't count — they're how you know it's a lab cluster, not lab values
// themselves.
const LAB_LABEL_PATTERNS: RegExp[] = [
  /\bpH(?=[\s:=|]+\d)/gi,
  /(?:PaCO₂|PaCO2|pCO₂|pCO2)(?=[\s:=|]+\d)/gi,
  // Exclude SpO₂ — that's pulse oximetry, not a blood-gas value.
  /(?<![Ss])(?:PaO₂|PaO2|pO₂|pO2)(?=[\s:=|]+\d)/gi,
  /(?:HCO₃|HCO3)(?=[\s:=|]+\d)/gi,
  /\blactate(?=[\s:=|]+\d)/gi,
  /\banion gap(?=[\s:=|]+\d)/gi,
  /(?:\bNa[⁺+]?|sodium)(?=[\s:=|]+\d)/gi,
  /(?:\bK[⁺+]?|potassium)(?=[\s:=|]+\d)/gi,
  /(?:\bCl[⁻-]?|chloride)(?=[\s:=|]+\d)/gi,
  /\bglucose(?=[\s:=|]+\d)/gi,
  /\b(?:creatinine|Cr)(?=[\s:=|]+\d)/gi,
  /\bBUN(?=[\s:=|]+\d)/gi,
  /(?:FiO₂|FiO2)(?=[\s:=|]+\d)/gi,
];

function countLabsWithValues(stem: string): number {
  let count = 0;
  for (const pat of LAB_LABEL_PATTERNS) {
    // `test` doesn't share state with `exec` on the same regex; safer to
    // create a non-global copy to count once-per-pattern.
    const single = new RegExp(pat.source, pat.flags.replace('g', ''));
    if (single.test(stem)) count++;
  }
  return count;
}

function isLabHeavyStem(stem: string): boolean {
  // Stem is lab-heavy if it has an ABG/VBG/blood-gas marker AND ≥3 distinct
  // lab labels each followed by a numeric value, OR ≥4 distinct lab-with-
  // value pairs without the gas marker. Tightened on 2026-05-15 from naive
  // signal counting (which over-triggered on "creatinine doubled since
  // yesterday" or anion-gap mentions without values).
  const labWithValueCount = countLabsWithValues(stem);
  if (/\b(ABG|VBG|blood gas)\b/i.test(stem)) {
    return labWithValueCount >= 3;
  }
  return labWithValueCount >= 4;
}

function isQuestionParagraph(paragraph: string): boolean {
  const trimmed = stripMarkdownTables(paragraph);
  return trimmed.endsWith('?') || trimmed.endsWith(':');
}

function validateOption(option: CuratedQuestionOption, index: number): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(option.label)) errors.push(`options[${index}].label is required`);
  if (!isNonEmptyString(option.text)) errors.push(`options[${index}].text is required`);
  if (typeof option.isCorrect !== 'boolean') errors.push(`options[${index}].isCorrect must be boolean`);
  return errors;
}

export function validateCuratedQuestion(question: CuratedQuestion): string[] {
  const errors: string[] = [];

  if (!isNonEmptyString(question.id)) errors.push('id is required');
  if (isNonEmptyString(question.id) && !question.id.startsWith('bank:')) {
    errors.push(`id must start with "bank:" (got "${question.id}")`);
  }

  if (!isNonEmptyString(question.rotation)) errors.push('rotation is required');
  if (typeof question.week !== 'undefined') {
    if (!Number.isFinite(question.week) || question.week <= 0) errors.push('week must be a positive int');
  }

  if (!Array.isArray(question.topics) || question.topics.length === 0) {
    errors.push('topics must be a non-empty array');
  } else {
    const emptyTopic = question.topics.find((t) => !isNonEmptyString(t));
    if (emptyTopic) errors.push('topics must not contain empty strings');
  }

  if (!isNonEmptyString(question.questionType)) errors.push('questionType is required');
  if (!isNonEmptyString(question.difficulty)) errors.push('difficulty is required');

  if (!isNonEmptyString(question.stem)) errors.push('stem is required');
  if (!isNonEmptyString(question.context)) errors.push('context is required');

  if (!Array.isArray(question.options) || question.options.length < 4) {
    errors.push('options must be an array of at least 4 items');
  } else if (question.options.length > 10) {
    errors.push('options must have at most 10 items');
  } else {
    for (let i = 0; i < question.options.length; i++) {
      errors.push(...validateOption(question.options[i], i));
    }

    const labels = question.options.map((o) => normalizeLabel(o.label));
    const uniqueLabels = new Set(labels);
    if (uniqueLabels.size !== labels.length) errors.push('options labels must be unique');

    const correctCount = question.options.filter((o) => o.isCorrect).length;
    if (correctCount !== 1) errors.push(`options must have exactly 1 correct answer (got ${correctCount})`);
  }

  // Validate combinations if present
  if (question.combinations && question.combinations.length > 0) {
    errors.push(...validateCombinations(question));
  }

  // Validate correctVariants if present
  if (question.correctVariants && question.correctVariants.length > 0) {
    for (let i = 0; i < question.correctVariants.length; i++) {
      if (!isNonEmptyString(question.correctVariants[i])) {
        errors.push(`correctVariants[${i}] must be a non-empty string`);
      } else if (question.correctVariants[i].length === 80) {
        errors.push(`correctVariants[${i}] is exactly 80 chars (likely truncated)`);
      }
    }
  }

  return errors;
}

/**
 * Validate option combinations for expanded option pools.
 * Rules:
 * - Exactly one option must be correct
 * - Each combination must have exactly 5 indices
 * - Each combination must include the correct answer index
 * - All indices must be valid (< options.length)
 */
function validateCombinations(question: CuratedQuestion): string[] {
  const errors: string[] = [];

  if (!question.combinations) return errors;

  // Find the correct answer index
  const correctIndex = question.options.findIndex((o) => o.isCorrect);
  if (correctIndex === -1) {
    // Already caught by the main validator
    return errors;
  }

  for (let i = 0; i < question.combinations.length; i++) {
    const combo = question.combinations[i];

    // Each combo must have exactly 5 options
    if (!Array.isArray(combo) || combo.length !== 5) {
      errors.push(`combinations[${i}] must have exactly 5 indices`);
      continue;
    }

    // Each combo must include the correct answer
    if (!combo.includes(correctIndex)) {
      errors.push(`combinations[${i}] must include index ${correctIndex} (correct answer)`);
    }

    // All indices must be valid
    for (const idx of combo) {
      if (typeof idx !== 'number' || idx < 0 || idx >= question.options.length) {
        errors.push(`combinations[${i}] has invalid index ${idx}`);
      }
    }

    // No duplicate indices within a combination
    const uniqueIndices = new Set(combo);
    if (uniqueIndices.size !== combo.length) {
      errors.push(`combinations[${i}] has duplicate indices`);
    }
  }

  return errors;
}

export function validateCuratedQuestionBank(questions: CuratedQuestion[]): string[] {
  const errors: string[] = [];

  const ids = questions.map((q) => q.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    errors.push(`duplicate ids: ${Array.from(new Set(dupes)).join(', ')}`);
  }

  for (const q of questions) {
    const qErrors = validateCuratedQuestion(q);
    for (const e of qErrors) errors.push(`${q.id || '<missing-id>'}: ${e}`);
  }

  return errors;
}

/**
 * Check for longest-answer-correct pattern (legacy — use checkLengthBias instead).
 */
export function checkLongestAnswerCorrect(
  questions: CuratedQuestion[],
  thresholdPercent = 10
): { id: string; correctLen: number; maxOtherLen: number; diff: number }[] {
  const flagged: { id: string; correctLen: number; maxOtherLen: number; diff: number }[] = [];

  for (const q of questions) {
    if (!Array.isArray(q.options) || q.options.length < 4) continue;

    const correctOpt = q.options.find((o) => o.isCorrect);
    if (!correctOpt) continue;

    const lengths = q.options.map((o) => o.text.length);
    const maxLen = Math.max(...lengths);
    const correctLen = correctOpt.text.length;

    const otherLens = q.options.filter((o) => !o.isCorrect).map((o) => o.text.length);
    const maxOtherLen = Math.max(...otherLens);

    const pctLonger = maxOtherLen > 0 ? ((correctLen - maxOtherLen) / maxOtherLen) * 100 : 0;
    if (correctLen === maxLen && pctLonger > thresholdPercent) {
      flagged.push({ id: q.id, correctLen, maxOtherLen, diff: correctLen - maxOtherLen });
    }
  }

  return flagged;
}

/**
 * Check for length bias — correct answer is longest OR shortest.
 * The correct answer must not be distinguishable by length alone.
 *
 * Uses two thresholds:
 * - Percentage difference (default 15%) — relative to the reference option
 * - Minimum absolute difference (default 6 chars) — avoids flagging "Osborn J waves" vs "Delta wave pattern"
 */
/**
 * Length bias in each RENDERED 5-option subset, not just the stored pool.
 *
 * checkLengthBias compares the correct answer against ALL other options. For a question
 * with `combinations`, that is the wrong denominator: getQuestionOptions renders a
 * SPECIFIC 5-option subset per attempt (display.ts:82-93), and a long distractor present
 * in the pool but ABSENT from a given combination MASKS the tell at pool level while the
 * student sees it plainly.
 *
 * Concretely: correct "Obsessive-compulsive disorder" (29 chars) looks fine beside a
 * 46-char distractor — but the combination that omits that distractor renders it against
 * 5-6 char options, and the answer is simply the long one.
 *
 * Measured 2026-07-17 across 696 live questions / 988 rendered subsets: the full-pool
 * check flags 0, while 8 questions carry a tell in a real render. All 8 are PAAM /
 * critical-care today; this gate exists to stop the class, not to fix those.
 *
 * Same principle as the contrast-set rendered gate (contrast-set.ts): validate what the
 * student actually SEES, not what happens to be stored.
 */
export function checkCombinationLengthBias(
  questions: CuratedQuestion[],
  thresholdPercent = 15,
  minAbsDiff = 6
): { id: string; comboIndex: number; bias: 'longest' | 'shortest'; correctLen: number; otherLen: number }[] {
  const flagged: { id: string; comboIndex: number; bias: 'longest' | 'shortest'; correctLen: number; otherLen: number }[] = [];

  for (const q of questions) {
    if (!Array.isArray(q.combinations) || q.combinations.length === 0) continue;
    if (!Array.isArray(q.options)) continue;

    const correctIndex = q.options.findIndex((o) => o.isCorrect);
    if (correctIndex === -1) continue;
    const correctLen = q.options[correctIndex].text.length;

    q.combinations.forEach((combo, comboIndex) => {
      // A combo without the correct option is already a hard error in
      // validateCombinations; don't crash here if malformed data reaches us.
      if (!Array.isArray(combo) || !combo.includes(correctIndex)) return;

      const otherLens = combo
        .filter((i) => i !== correctIndex)
        .map((i) => q.options[i]?.text.length)
        .filter((n): n is number => typeof n === 'number');
      if (otherLens.length === 0) return;

      const maxOther = Math.max(...otherLens);
      const minOther = Math.min(...otherLens);

      if (correctLen > maxOther) {
        const absDiff = correctLen - maxOther;
        const pctDiff = maxOther > 0 ? Math.round((absDiff / maxOther) * 100) : 0;
        if (pctDiff > thresholdPercent && absDiff >= minAbsDiff) {
          flagged.push({ id: q.id, comboIndex, bias: 'longest', correctLen, otherLen: maxOther });
          return;
        }
      }
      if (correctLen < minOther) {
        const absDiff = minOther - correctLen;
        const pctDiff = correctLen > 0 ? Math.round((absDiff / correctLen) * 100) : 0;
        if (pctDiff > thresholdPercent && absDiff >= minAbsDiff) {
          flagged.push({ id: q.id, comboIndex, bias: 'shortest', correctLen, otherLen: minOther });
        }
      }
    });
  }

  return flagged;
}

export function checkLengthBias(
  questions: CuratedQuestion[],
  thresholdPercent = 15,
  minAbsDiff = 6
): { id: string; bias: 'longest' | 'shortest'; correctLen: number; maxOtherLen: number; minOtherLen: number; pctDiff: number }[] {
  const flagged: { id: string; bias: 'longest' | 'shortest'; correctLen: number; maxOtherLen: number; minOtherLen: number; pctDiff: number }[] = [];

  for (const q of questions) {
    if (!Array.isArray(q.options) || q.options.length < 4) continue;

    const correctOpt = q.options.find((o) => o.isCorrect);
    if (!correctOpt) continue;

    const correctLen = correctOpt.text.length;
    const otherLens = q.options.filter((o) => !o.isCorrect).map((o) => o.text.length);
    const maxOtherLen = Math.max(...otherLens);
    const minOtherLen = Math.min(...otherLens);

    // Check longest
    if (correctLen > maxOtherLen) {
      const absDiff = correctLen - maxOtherLen;
      const pctDiff = maxOtherLen > 0 ? Math.round(((correctLen - maxOtherLen) / maxOtherLen) * 100) : 0;
      if (pctDiff > thresholdPercent && absDiff >= minAbsDiff) {
        flagged.push({ id: q.id, bias: 'longest', correctLen, maxOtherLen, minOtherLen, pctDiff });
        continue;
      }
    }

    // Check shortest
    if (correctLen < minOtherLen) {
      const absDiff = minOtherLen - correctLen;
      const pctDiff = correctLen > 0 ? Math.round(((minOtherLen - correctLen) / correctLen) * 100) : 0;
      if (pctDiff > thresholdPercent && absDiff >= minAbsDiff) {
        flagged.push({ id: q.id, bias: 'shortest', correctLen, maxOtherLen, minOtherLen, pctDiff });
      }
    }
  }

  return flagged;
}

/**
 * Check for option letter references in explanations.
 * Options are shuffled at render time, so "Option B is wrong" becomes
 * misleading after shuffle. Explanations must use option text instead.
 */
export function checkOptionLetterRefs(
  questions: CuratedQuestion[]
): { id: string; refs: string[] }[] {
  const flagged: { id: string; refs: string[] }[] = [];
  const pattern = /Option [A-E]\b/g;

  for (const q of questions) {
    if (!q.context) continue;
    const matches = q.context.match(pattern);
    if (matches && matches.length > 0) {
      flagged.push({ id: q.id, refs: [...new Set(matches)] });
    }
  }

  return flagged;
}

/**
 * Check for format asymmetry — correct answer has different formatting from distractors.
 * Catches: unique informational parentheticals, unique symbols/arrows.
 * Does NOT flag standard abbreviation expansions like "(LMWH)" or "(INR)".
 */
/**
 * Check for bare ASCII chemistry/physiology notation that should use Unicode subscripts.
 * e.g. "CO2" should be "CO₂", "Ca2+" should be "Ca²⁺"
 */
export function checkBareSubscripts(
  questions: CuratedQuestion[]
): { id: string; fields: string[] }[] {
  const flagged: { id: string; fields: string[] }[] = [];

  // Match common bare subscript patterns — must use word boundaries carefully
  // to avoid false positives. Order matters: longer patterns first to avoid
  // partial matches.
  const barePatterns = [
    /\bNaHCO3\b/,
    /\bH2CO3\b/,
    /\bPaCO2\b/,
    /\bEtCO2\b/,
    /\bcmH2O\b/,
    /\bPaO2\b/,
    /\bFiO2\b/,
    /\bSpO2\b/,
    /\bSaO2\b/,
    /\bHCO3\b/,
    /\bCO2\b/,
    /\bH2O\b/,
    /\bN2O\b/,
    /\bNH4\+/,
    /\bSO4\b/,
    /\bCa2\+/,
    /\bMg2\+/,
    /\bFe2\+/,
    /\bFe3\+/,
    /\bK\+/,
    /\bNa\+/,
  ];

  function hasBareSubscript(text: string): boolean {
    return barePatterns.some((p) => p.test(text));
  }

  for (const q of questions) {
    const fields: string[] = [];

    if (q.stem && hasBareSubscript(q.stem)) fields.push('stem');
    if (q.context && hasBareSubscript(q.context)) fields.push('context');

    if (Array.isArray(q.options)) {
      const anyOptionBare = q.options.some((o) => hasBareSubscript(o.text));
      if (anyOptionBare) fields.push('options');
    }

    if (fields.length > 0) {
      flagged.push({ id: q.id, fields });
    }
  }

  return flagged;
}

/**
 * Check for negative stem patterns (NOT, EXCEPT, LEAST likely).
 * These are pedagogically weak — they test elimination rather than knowledge.
 */
export function checkNegativeStemType(
  questions: CuratedQuestion[]
): { id: string; pattern: string }[] {
  const flagged: { id: string; pattern: string }[] = [];

  const patterns: { regex: RegExp; label: string }[] = [
    { regex: /\bNOT\b/, label: 'NOT' },
    { regex: /\bEXCEPT\b/, label: 'EXCEPT' },
    { regex: /\bLEAST\s+likely\b/i, label: 'LEAST likely' },
  ];

  for (const q of questions) {
    if (!q.stem) continue;
    for (const { regex, label } of patterns) {
      if (regex.test(q.stem)) {
        flagged.push({ id: q.id, pattern: label });
        break; // one flag per question
      }
    }
  }

  return flagged;
}

/**
 * Check for stems that don't end with a question mark or colon.
 * Well-formed MCQ stems should end with "?" or ":" to make the lead-in clear.
 */
export function checkMissingTerminalQuestion(
  questions: CuratedQuestion[]
): { id: string; stemEnd: string }[] {
  const flagged: { id: string; stemEnd: string }[] = [];

  for (const q of questions) {
    if (!q.stem) continue;
    const trimmed = q.stem.trim();
    const lastChar = trimmed[trimmed.length - 1];
    if (lastChar !== '?' && lastChar !== ':') {
      const stemEnd = trimmed.slice(-20).trim();
      flagged.push({ id: q.id, stemEnd });
    }
  }

  return flagged;
}

export function checkExamStyleCalibration(
  questions: CuratedQuestion[]
): { id: string; issue: 'missing-question-paragraph' | 'long-setup-before-question' | 'lab-stem-without-table' | 'lab-table-without-reference-ranges'; detail: string }[] {
  const flagged: {
    id: string;
    issue: 'missing-question-paragraph' | 'long-setup-before-question' | 'lab-stem-without-table' | 'lab-table-without-reference-ranges';
    detail: string;
  }[] = [];

  for (const q of questions) {
    if (!q.stem) continue;

    const stem = q.stem.trim();
    const paragraphs = splitStemParagraphs(stem);
    const questionParagraphIndex = paragraphs.findLastIndex((paragraph) => isQuestionParagraph(paragraph));

    if (questionParagraphIndex !== -1) {
      const questionParagraph = stripMarkdownTables(paragraphs[questionParagraphIndex]);
      const questionParagraphSentences = countSentences(questionParagraph);
      const setupText = paragraphs
        .slice(0, questionParagraphIndex)
        .map((paragraph) => stripMarkdownTables(paragraph))
        .join(' ');
      const setupSentenceCount = countSentences(setupText);

      if (
        (questionParagraphIndex === 0 && questionParagraphSentences > 1) ||
        (questionParagraphIndex > 0 && questionParagraphSentences > 1)
      ) {
        flagged.push({
          id: q.id,
          issue: 'missing-question-paragraph',
          detail: 'stem should end with a standalone question paragraph after the setup',
        });
      }

      // Critical-care KAT vignettes routinely pack history + vitals + exam +
      // labs + imaging + deterioration into 8-10 setup sentences — that's the
      // shape of the real exam. Threshold > 10 catches genuine wall-of-text
      // (≥11 sentences) where textbook case-studies have leaked in without
      // the deletion or editorial trim a normal exam vignette would receive.
      // 2026-05-15 calibration: original >7 false-flagged ~80 legitimate CC
      // KAT cases; >10 keeps the top ~5% of length, the actual outliers.
      if (setupSentenceCount > 10) {
        flagged.push({
          id: q.id,
          issue: 'long-setup-before-question',
          detail: `setup has ${setupSentenceCount} sentences before the question lead-in`,
        });
      }
    }

    if (!isLabHeavyStem(stem)) continue;

    // Stems that already annotate every lab with `(normal …)` inline don't
    // gain anything from a duplicate markdown table — the reference range is
    // already at point of use. Count the annotations; if there are ≥3 the
    // stem is adequately ranged.
    const inlineRangeCount = (stem.match(/\(normal\s+[^)]+\)/gi) || []).length;
    if (inlineRangeCount >= 3) continue;

    const hasTable = containsMarkdownTable(stem);
    if (!hasTable) {
      flagged.push({
        id: q.id,
        issue: 'lab-stem-without-table',
        detail: 'lab-heavy stem should use a markdown table instead of inline values',
      });
      continue;
    }

    if (!hasReferenceRangeColumn(stem)) {
      flagged.push({
        id: q.id,
        issue: 'lab-table-without-reference-ranges',
        detail: 'lab table should include a Normal/Reference range column',
      });
    }
  }

  return flagged;
}

/**
 * Check for truncated text in options, stems, and correctVariants.
 * Catches text that ends mid-sentence (with a preposition, article, or adjective
 * that clearly needs a following word).
 */
export function checkTruncatedText(
  questions: CuratedQuestion[]
): { id: string; field: string; text: string }[] {
  const flagged: { id: string; field: string; text: string }[] = [];

  // Words that strongly indicate truncation when they end a text fragment.
  // Only longer words (3+ chars) are checked case-insensitively.
  // Short words (a, an, or) must be lowercase to avoid false positives on
  // medical terms like "Stanford A", "PAPP-A", "haemophilia A".
  const longWordEndings = /\b(and|the|for|with|from|that|which|this|these|their|multiple|associated|including|anticipatory|comorbid|resulting|causing|involving|presenting|developing|especially)\s*$/i;
  const shortWordEndings = /\s(a|an|or|of|in|to|by|as|at|on)\s*$/;

  function looksIncomplete(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < 40) return false;
    // Already ends with sentence punctuation — fine
    if (/[.?!;:)"']$/.test(trimmed)) return false;
    return longWordEndings.test(trimmed) || shortWordEndings.test(trimmed);
  }

  for (const q of questions) {
    // Check stem
    if (q.stem && looksIncomplete(q.stem)) {
      flagged.push({ id: q.id, field: 'stem', text: q.stem.slice(-40) });
    }

    // Check options
    if (Array.isArray(q.options)) {
      for (let i = 0; i < q.options.length; i++) {
        if (looksIncomplete(q.options[i].text)) {
          flagged.push({ id: q.id, field: `options[${i}]`, text: q.options[i].text });
        }
      }
    }

    // Check correctVariants
    if (q.correctVariants) {
      for (let i = 0; i < q.correctVariants.length; i++) {
        if (looksIncomplete(q.correctVariants[i])) {
          flagged.push({ id: q.id, field: `correctVariants[${i}]`, text: q.correctVariants[i] });
        }
      }
    }
  }

  return flagged;
}

export function checkFormatAsymmetry(
  questions: CuratedQuestion[]
): { id: string; issue: string }[] {
  const flagged: { id: string; issue: string }[] = [];

  // Abbreviation expansion: single uppercase word 2-6 chars, e.g. "(LMWH)", "(INR)"
  const abbrOnly = /^\([A-Z]{2,6}\)$/;

  for (const q of questions) {
    if (!Array.isArray(q.options) || q.options.length < 4) continue;

    const correctOpt = q.options.find((o) => o.isCorrect);
    if (!correctOpt) continue;
    const distractors = q.options.filter((o) => !o.isCorrect);

    // Check informational parentheticals (not abbreviation expansions)
    // Only flag when correct has informational parens and NO distractors do
    const infoParenPattern = /\([^)]+\)/g;
    const correctParens = correctOpt.text.match(infoParenPattern) || [];
    const correctInfoParens = correctParens.filter((p) => !abbrOnly.test(p));

    if (correctInfoParens.length > 0) {
      const distractorsWithInfoParens = distractors.filter((d) => {
        const parens = d.text.match(infoParenPattern) || [];
        return parens.some((p) => !abbrOnly.test(p));
      });
      if (distractorsWithInfoParens.length === 0) {
        flagged.push({ id: q.id, issue: 'Correct answer has unique parenthetical formatting' });
        continue;
      }
    }

    // Check symbol/arrow usage: correct uses arrows/symbols, distractors don't (or vice versa)
    const symbolPattern = /[↑↓→←±≥≤]/;
    const correctHasSymbols = symbolPattern.test(correctOpt.text);
    const distractorsWithSymbols = distractors.filter((d) => symbolPattern.test(d.text));

    if (correctHasSymbols && distractorsWithSymbols.length === 0) {
      flagged.push({ id: q.id, issue: 'Correct answer has unique symbol/arrow format' });
      continue;
    }
    if (!correctHasSymbols && distractorsWithSymbols.length === distractors.length) {
      flagged.push({ id: q.id, issue: 'All distractors use symbols but correct does not' });
      continue;
    }
  }

  return flagged;
}
