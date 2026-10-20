/**
 * Options that point at other options: "Both A and B", "A and C only", "All of
 * the above", "None of the above". Shuffled, they name the wrong options; under
 * a numbered badge, a letter means nothing. So a question whose options do
 * this keeps its stored order and shows letters (owner, 2026-10-07: "the
 * feedback references specific letters which doesn't work if we shuffle
 * answers"; the question bank holds about 160 such options).
 */
// Option letters are capitals; the words around them may be either case.
// Case-insensitive letters read "cord", "bore" and "only a" as references.
// Not after a hyphen or slash: "Anti-D only" is a drug, not option D.
const LETTER = '(?<![-/])[A-E]';
const WORD = (word: string) => word.split('').map((c) => (/[a-z]/i.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c)).join('');
const REFERS_TO_OPTIONS = new RegExp(
  [
    `\\b(?:${['both', 'neither', 'only', 'all of', 'none of'].map(WORD).join('|')})\\s+${LETTER}\\b`,
    `\\b${LETTER}\\s*(?:,|\\s(?:and|or|nor|&)\\s)\\s*${LETTER}\\b`,
    `\\b${LETTER}\\s+${WORD('only')}\\b`,
    `\\b(?:${['all', 'none', 'both', 'neither'].map(WORD).join('|')}) ${WORD('of the')} (?:${['above', 'options', 'statements'].map(WORD).join('|')})\\b`,
    `^\\s*${LETTER}\\s*$`,
  ].join('|'),
);

/** Clinical letters that look like option letters: vitamin A, hepatitis B and C, type A, A and B blood groups. */
const CLINICAL_LETTERS = /\b(?:vitamins?|hepatitis|hep|types?|groups?|blood group|haemophilia|influenza|class|grade|zone|lymphocytes?|cells?|clusters?)\s+\(?[A-E]\b/i;

export function optionRefersToOthers(text: string): boolean {
  const trimmed = text.trim();
  if (!REFERS_TO_OPTIONS.test(trimmed)) return false;
  if (/of the above|of the options|of the statements/i.test(trimmed)) return true;
  return !CLINICAL_LETTERS.test(trimmed);
}

export function optionsCrossReference(texts: readonly string[]): boolean {
  return texts.some(optionRefersToOthers);
}
