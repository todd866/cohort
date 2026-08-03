/**
 * Detect MCQ stems that produce bad cloze cards and should stay MCQ-only.
 *
 * Returns true for:
 * - "Which of the following" patterns (answer is typically a long option)
 * - "Which set correctly lists" / "Which combination" (list-type answers)
 * - Stems where the correct answer would be >5 words as a cloze blank
 *
 * When this returns true, the card extractor skips card generation entirely
 * (the MCQ exists in the question bank already).
 */
export function shouldSkipClozeConversion(stem: string, correctAnswerText: string): boolean {
  const s = stem.trim().toLowerCase();

  // "Which of the following" — answer is one of N options, bad as a cloze blank
  if (/which of the following/i.test(s)) return true;

  // "Which set/combination/list" — answer is a multi-component bundle that
  // cannot be a 1-2 word cloze without losing the point of the set. Match
  // anywhere in the stem (not just start) since most clinical MCQs prefix
  // the question with a scenario paragraph.
  if (/\bwhich\s+(?:set|combination|list|grouping|profile|cluster|panel|triad|tetrad|pentad)\b/i.test(s)) return true;

  // "What is a characteristic/common/typical symptom/feature/sign of X?" — answer is one of many valid options
  if (/what\s+is\s+a\s+(?:characteristic|common|typical|classic|frequent|recognised)\s+(?:symptom|feature|sign|finding|manifestation|complication|cause|side.?effect)\s+of/i.test(s)) return true;

  // Negative questions: "NOT", "EXCEPT", "LEAST likely" — answer is one-of-many-wrong,
  // makes terrible cloze cards. Match standalone NOT/EXCEPT/LEAST (not as part of words).
  if (/\bNOT\b/.test(stem) || /\bEXCEPT\b/.test(stem) || /\bLEAST\s+likely\b/i.test(s)) return true;

  // List-asking stems with multi-item answers — skip rather than truncate.
  // Without this, trimAnswerForCloze keeps only the first item and we end up
  // with under-specified cloze cards like
  //   "Main risk factors for ROP are [___]" → "Low gestational age"
  // when the real answer is the full triad. Better to keep the parent MCQ
  // as the only teachable unit.
  const isListStem = /^(?:what\s+are\b|list\b|name(?:\s+three|\s+two|\s+the)?\b)/i.test(s)
    || /\bmain\s+(?:risk\s+)?(?:factors?|causes?|organisms?|components?|features?|signs?|symptoms?|complications?|indications?|contraindications?)\b/i.test(s)
    || /\bwhat\s+are\s+the\b/i.test(s);
  const answerIsList = (correctAnswerText.match(/,/g) ?? []).length >= 1
    || /\band\b/i.test(correctAnswerText);
  if (isListStem && answerIsList) return true;

  // Answer too long for a cloze blank. We trim trailing parentheticals and
  // em-dash elaborations first (see trimAnswerForCloze), then enforce the
  // 1-2 word target — true 3-word terminal medical concepts (e.g. "GABA-A
  // receptor potentiation") should remain MCQ-only and not generate a
  // reinforcement cloze, since the cloze form fails the granularity rule.
  const trimmed = trimAnswerForCloze(correctAnswerText);
  if (!trimmed) return true;
  if (trimmed.split(/\s+/).length > 2) return true;

  // Clinical scenario stems are normally long. Cap at 500 chars (was 200) —
  // most med MCQs have multi-sentence vignettes that the splitStemQuestion
  // step handles cleanly.
  if (stem.length > 500) return true;

  return false;
}

/**
 * Trim a multi-word MCQ answer down to a 1-2 word cloze blank where possible.
 *
 * Heuristics applied in order:
 *  1. Drop trailing parenthetical: "Class II (15-30% loss)" → "Class II"
 *  2. Drop em-dash / en-dash elaboration: "Mobitz II — fixed PR" → "Mobitz II"
 *  3. Drop trailing comma-list: "Bradycardia, hypertension, ..." → "Bradycardia"
 *  4. Drop leading articles: "The carotid sinus" → "carotid sinus"
 *  5. Drop trailing punctuation
 *
 * Returns the trimmed string, or null if the result is empty / a generic
 * filler ("yes", "no", "all", "none", etc.) that doesn't make a good blank.
 */
export function trimAnswerForCloze(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;

  // 1. trailing parenthetical
  s = s.replace(/\s*\([^)]*\)\s*$/g, '').trim();
  // 2. em-dash / en-dash elaboration
  s = s.replace(/\s+[—–-]\s+.*$/, '').trim();
  // 3. trailing comma-list — keep the first item only when there are 2+ commas
  //    (single-comma items often indicate an appositive, e.g. "TSH, the screening test")
  if ((s.match(/,/g) ?? []).length >= 2) {
    s = s.split(',')[0].trim();
  }
  // 4. trailing punctuation
  s = s.replace(/[.,;:!?]+$/, '').trim();
  // 5. leading article
  s = s.replace(/^(?:the|a|an)\s+/i, '').trim();

  if (!s) return null;
  const generics = new Set([
    'yes', 'no', 'all', 'none', 'true', 'false', 'all of the above',
    'none of the above', 'either', 'neither', 'any', 'some',
  ]);
  if (generics.has(s.toLowerCase())) return null;

  return s;
}

/**
 * Detect MCQs whose correct answer makes the resulting flashcard low-value even
 * as a plain Q/A card.
 */
export function shouldOmitMcqCard(stem: string, correctAnswerText: string): boolean {
  const answer = correctAnswerText.trim().toLowerCase();
  const question = stem.trim().toLowerCase();

  if (/\b(?:all|none)\s+of\s+(?:the\s+)?above\b/.test(answer)) return true;
  if (/\ball\s+of\s+(?:the\s+)?listed\b/.test(answer)) return true;

  if (/\b(?:not|except|least likely|false)\b/.test(question) && /\ball\b/.test(answer)) {
    return true;
  }

  return false;
}

/**
 * Convert an MCQ question stem + correct answer into a proper cloze card.
 *
 * Instead of "What is X?\n\nAnswer: [___]", produces "X is [___]."
 * The result is a statement with an embedded blank that tests recall.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function mcqToCloze(stem: string, _correctAnswer: string): string | null {
  // Split into scenario (multi-sentence context) and question (last sentence)
  const { scenario, question } = splitStemQuestion(stem);

  // Convert the question to a cloze statement
  const clozeStatement = questionToStatement(question);

  // Post-conversion validation: reject broken cloze cards
  // 1. Statement still starts with a question word → fallback produced garbage
  if (/^(?:What|Which|How|When|Why|Where|Who)\s/i.test(clozeStatement)) return null;
  // 2. Statement is just "[noun]: [___]." with no verb → not a proper sentence
  if (/^[^.]+:\s*\[___\]\.$/.test(clozeStatement) && !/\b(?:is|are|was|were|has|have|means|requires)\b/i.test(clozeStatement)) return null;

  // Reassemble: scenario + cloze statement, preserving paragraph break.
  if (scenario) {
    return `${scenario}\n\n${clozeStatement}`;
  }
  return clozeStatement;
}

/**
 * Split a stem into the clinical scenario (context) and the actual question.
 * The question is typically the last sentence that ends with '?'.
 */
function splitStemQuestion(stem: string): { scenario: string; question: string } {
  const trimmed = stem.trim();

  // Find the last question mark
  const lastQ = trimmed.lastIndexOf('?');
  if (lastQ === -1) {
    return { scenario: '', question: trimmed };
  }

  // Find the start of the question sentence
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _beforeQ = trimmed.slice(0, lastQ + 1);
  let splitIndex = -1;

  for (let i = lastQ - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (ch === '\n') {
      splitIndex = i;
      break;
    }
    if (ch === '.') {
      const after = trimmed[i + 1];
      if (after && (after === ' ' || after === '\n')) {
        // Skip decimal points (7.25, 0.5)
        const before = i > 0 ? trimmed[i - 1] : '';
        const afterChar = trimmed[i + 2] ?? '';
        if (/\d/.test(before) && /\d/.test(after === ' ' ? afterChar : after)) {
          continue;
        }
        // Skip common abbreviations
        const wordBefore = trimmed.slice(Math.max(0, i - 5), i);
        if (/(?:Dr|Mr|Ms|vs|etc|e\.g|i\.e|St|Hb|pH|No|Lt|Rt|mL|mg|mmHg)$/i.test(wordBefore)) {
          continue;
        }
        splitIndex = i;
        break;
      }
    }
  }

  if (splitIndex === -1) {
    return { scenario: '', question: trimmed };
  }

  const scenario = trimmed.slice(0, splitIndex + 1).trim();
  const question = trimmed.slice(splitIndex + 1).trim();

  if (question.length < 10) {
    return { scenario: '', question: trimmed };
  }

  return { scenario, question };
}

/**
 * Convert a question sentence into a cloze statement with [___].
 *
 * Handles common MCQ question patterns and converts them to statements.
 */
function questionToStatement(question: string): string {
  const q = question.trim();

  // Try existing patterns first — many of them ("In X, what does Y represent?",
  // "For X, what is the Y?") rely on the prefix being present in the stem and
  // would break if we stripped it.
  const directResult = patternMatch(q);
  const directIsFallback = /:\s*\[___\]\.$/.test(directResult);
  if (!directIsFallback) return directResult;

  // Direct match fell through to the colon-fallback. Try stripping a leading
  // scenario prefix ("In suspected preterm labor,", "During cardiac arrest,")
  // when followed by a question word — gives the inner patterns a clean shot.
  let prefix = '';
  let inner = q;
  const prefixMatch = q.match(/^((?:In|During|After|Following|Before|On|With)\s+[^,?]{4,80}),\s+((?:Which|What|Why|When|How|Where|Who|Identify|Select|Name|List)\b.*)$/i);
  if (prefixMatch) {
    prefix = prefixMatch[1].trim();
    inner = prefixMatch[2].trim();
    if (!inner.endsWith('?')) inner += '?';
  }
  if (!prefix) return directResult;

  const result = patternMatch(inner);
  // If the inner pattern ALSO fell through to the colon-fallback, prefer the
  // direct (un-stripped) result — it preserves the original phrasing.
  if (/:\s*\[___\]\.$/.test(result)) return directResult;

  // Reattach the prefix to the cloze statement.
  // Drop the prefix when reattachment would duplicate it.
  if (result.toLowerCase().includes(prefix.toLowerCase())) return result;
  const lcResult = result.charAt(0).toLowerCase() + result.slice(1);
  return `${prefix}, ${lcResult}`;
}

function patternMatch(question: string): string {
  const q = question.trim();

  // === Pattern N1: "What [noun] is (most|least|best|first-line) [adj] for [target]?" ===
  // "What ECG finding is most specific for hyperkalaemia?" →
  //   "The most specific ECG finding for hyperkalaemia is [___]."
  {
    const m = q.match(
      /^What\s+(.+?)\s+is\s+(?:the\s+)?(most|least|best|first[ -]?line|primary|main)\s+(.+?)\s+for\s+(.+?)\s*\?$/i
    );
    if (m) {
      const noun = m[1].trim();
      const quantifier = m[2].trim().replace(/\s+/g, '-'); // "first line" → "first-line"
      const adj = m[3].trim();
      const target = m[4].trim();
      // "first-line" reads better as a hyphenated qualifier; others stay separate
      return `The ${quantifier} ${adj} ${noun} for ${target} is [___].`;
    }
  }

  // === Pattern N2: "What [noun] is the (best|most|first-line) [adj]?" — without "for" ===
  // "What test is the best initial screen for hypothyroidism?" →
  //   "The best initial screen test for hypothyroidism is [___]."
  // Note: this handles cases where the [adj] phrase already contains "for" or modifiers.
  {
    const m = q.match(
      /^What\s+(.+?)\s+is\s+the\s+(best|most|least|first[ -]?line|primary|main)\s+(.+?)\s*\?$/i
    );
    if (m) {
      const noun = m[1].trim();
      const quantifier = m[2].trim().replace(/\s+/g, '-');
      const adj = m[3].trim();
      return `The ${quantifier} ${adj} ${noun} is [___].`;
    }
  }

  // === Pattern N3: "X is/are characteristic of which Y?" — declarative-with-which ===
  // "Delta waves are characteristic of which stage of sleep?" →
  //   "Delta waves are characteristic of [___]."
  {
    const m = q.match(
      /^(.+?)\s+(is|are)\s+(characteristic|typical|suggestive|pathognomonic|diagnostic|specific)\s+of\s+which\s+(.+?)\s*\?$/i
    );
    if (m) {
      return `${cap(m[1])} ${m[2]} ${m[3]} of [___].`;
    }
  }

  // === Pattern N4: stem ends with colon — declarative completion ===
  // "Hyperventilation reduces ICP via:" → "Hyperventilation reduces ICP via [___]."
  // "Cushing reflex includes:" → "Cushing reflex includes [___]."
  // Only fires when the stem reads as a declarative statement that hints at
  // a continuation (no question word, ends with ":"). Limited to short stems
  // (≤120 chars) to avoid catching lab-panel headers and bulleted lists.
  if (q.endsWith(':') && q.length <= 120 && !/^(?:What|Which|How|When|Why|Where|Who)\b/i.test(q)) {
    const stripped = q.replace(/:$/, '').trim();
    return `${stripped} [___].`;
  }

  // === Pattern 12: "In X, what does Y represent?" / "In X, what is the Y?" ===
  {
    const m = q.match(
      /^In\s+(.*?),\s+what\s+does\s+(.*?)\s+(represent|stand for|mean|indicate|signify)\s*\?$/i
    );
    if (m) {
      const verb = m[3] === 'stand for' ? 'stands for' : `${m[3]}s`;
      return `In ${m[1]}, ${m[2]} ${verb} [___].`;
    }
  }
  {
    const m = q.match(
      /^In\s+(.*?),\s+what\s+(is|are)\s+the\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `In ${m[1]}, the ${m[3]} ${m[2]} [___].`;
    }
  }

  // === Pattern 11: "For X, which/what Y is Z?" ===
  {
    const m = q.match(
      /^For\s+(.*?),\s+which\s+(.*?)\s+is\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `The ${m[2]} ${m[3]} for ${m[1]} is [___].`;
    }
  }
  {
    const m = q.match(
      /^For\s+(.*?),\s+what\s+(is|are)\s+the\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `The ${m[3]} for ${m[1]} ${m[2]} [___].`;
    }
  }

  // === "Which of the following" patterns ===
  {
    const m = q.match(
      /^Which of the following\s+(.*?)\s*\?$/i
    );
    if (m) {
      const rest = m[1];
      // Try to find a verb: "rhythms requires defibrillation"
      const verbMatch = rest.match(/^(.+?)\s+(is|are|requires|was|should|can|has|would)\s+(.*)/i);
      if (verbMatch) {
        return `The ${verbMatch[1]} that ${verbMatch[2]} ${verbMatch[3]} is [___].`;
      }
      return `The following ${rest}: [___].`;
    }
  }

  // === "Which statement/set/combination about X is Y?" ===
  {
    const m = q.match(
      /^Which\s+(statement|set|combination|description)\s+(?:about|regarding)\s+(.*?)\s+is\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `Regarding ${m[2]}: [___] (${m[3].toLowerCase()}).`;
    }
  }

  // === "Which is/are the X?" → "The X is/are [___]." ===
  // Symmetric to the "What is/are the X?" pattern below; must fire BEFORE the
  // generic "Which [noun] is/are [verb]" pattern, otherwise that one captures
  // "is" as part of the noun phrase and produces garbage like
  // "The is the most common that cause of X is [___]."
  {
    const m = q.match(/^Which\s+(is|are)\s+the\s+(.*?)\s*\?$/i);
    if (m) {
      return `The ${m[2]} ${m[1]} [___].`;
    }
  }

  // === "Which [noun] is contraindicated [in Y]?" — handle pre-2 generic Which ===
  // The generic "Which [noun] is/are [adj]" pattern below produces
  // "The contraceptive method that is contraindicated is [___]." — readable
  // but verbose. Convert directly to "The contraindicated [noun] is [___]."
  {
    const m = q.match(/^Which\s+(.+?)\s+is\s+contraindicated(?:\s+in\s+(.+?))?\s*\?$/i);
    if (m) {
      const noun = m[1].trim();
      const target = m[2]?.trim();
      return target
        ? `The contraindicated ${noun} in ${target} is [___].`
        : `The contraindicated ${noun} is [___].`;
    }
  }

  // === "Which scenario is a contraindication to X?" ===
  {
    const m = q.match(/^Which\s+(?:scenario|situation|condition)\s+is\s+a\s+contraindication\s+to\s+(.+?)\s*\?$/i);
    if (m) {
      return `A contraindication to ${m[1].trim()} is [___].`;
    }
  }

  // === "Which [noun] is/are/does [rest]?" — capture verb and include it ===
  // Verb list extended to cover common clinical action verbs (confirms,
  // produces, prevents, etc.) so questions like "Which ECG feature confirms
  // STEMI?" convert to "The ECG feature that confirms STEMI is [___]."
  {
    const m = q.match(
      /^Which\s+([\w\s]+?)\s+(is|are|does|was|were|has|have|had|would be|should be|can|could|may|might|will|best (?:reflects|describes|matches|explains|fits|predicts)|MOST (?:likely|accurately|commonly|appropriately)|confirms?|treats?|causes?|produces?|prevents?|reduces?|increases?|decreases?|reverses?|stops?|starts?|triggers?|inhibits?|activates?|blocks?|antagoni[sz]es?|stimulates?|requires?|indicates?|suggests?|distinguishes?|differentiates?|results? in|leads? to)\s+(.*?)\s*\?$/i
    );
    if (m) {
      const nounPhrase = m[1].trim();
      const verb = m[2].trim();
      const rest = m[3].trim();
      return `The ${nounPhrase} that ${verb} ${rest} is [___].`;
    }
  }

  // === Simple "Which X?" without a clear verb ===
  {
    const m = q.match(/^Which\s+(.*?)\s*\?$/i);
    if (m) {
      const rest = m[1];
      // Check for "is/are" verb
      const verbMatch = rest.match(/^(.*?)\s+(is|are|does)\s+(.*)/i);
      if (verbMatch) {
        return `The ${verbMatch[1]} that ${verbMatch[2]} ${verbMatch[3]} is [___].`;
      }
      return `The ${rest}: [___].`;
    }
  }

  // === Pattern 7: "What should you do FIRST?" ===
  {
    const m = q.match(/^What\s+should\s+you\s+do\s+FIRST\s*\?$/i);
    if (m) {
      return 'The first step is [___].';
    }
  }

  // === Pattern 8: "What distinguishes X from Y?" ===
  {
    const m = q.match(
      /^What\s+distinguishes\s+(.*?)\s+from\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `The finding that distinguishes ${m[1]} from ${m[2]} is [___].`;
    }
  }

  // === "What (best|most likely) explains X?" → "X is best explained by [___]." ===
  {
    const m = q.match(
      /^What\s+(?:best|most\s+likely|most|best\s+(?:explains|accounts\s+for))\s+(?:explains|accounts\s+for)\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `${cap(m[1])} is best explained by [___].`;
    }
  }
  {
    // Simpler form: "What explains X?"
    const m = q.match(/^What\s+explains\s+(.*?)\s*\?$/i);
    if (m) {
      return `${cap(m[1])} is explained by [___].`;
    }
  }

  // === "In which X is/are Y [adj]?" → "Y is [adj] in [___]." ===
  // e.g. "In which psychiatric conditions is ECT considered particularly effective?"
  //   → "ECT is considered particularly effective in [___]."
  {
    const m = q.match(
      /^In\s+which\s+(?:\w+\s+){0,4}(?:is|are)\s+(.+?)\s+(considered\s+.+?|.+?)\s*\?$/i
    );
    if (m) {
      const subj = m[1].trim();
      const adj = m[2].trim();
      return `${cap(subj)} is ${adj} in [___].`;
    }
  }

  // === Pattern 9: "What does X stand for (in Y)?" ===
  {
    const m = q.match(
      /^What\s+does\s+(.*?)\s+stand\s+for\s+in\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `In ${m[2]}, ${m[1]} stands for [___].`;
    }
  }
  {
    const m = q.match(
      /^What\s+does\s+(.*?)\s+stand\s+for\s*\?$/i
    );
    if (m) {
      return `${m[1]} stands for [___].`;
    }
  }

  // === Pattern 1: "What [noun] is characteristic/typical/suggestive of X?" ===
  {
    const m = q.match(
      /^What\s+(.*?)\s+is\s+(characteristic|typical|suggestive|indicative|pathognomonic|diagnostic|predictive)\s+of\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `The ${m[1]} ${m[2]} of ${m[3]} is [___].`;
    }
  }

  // === Pattern 2: "What [noun] defines/confirms/diagnoses X?" ===
  {
    const m = q.match(
      /^What\s+(.*?)\s+(defines|confirms|diagnoses|identifies|establishes|determines)\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `The ${m[1]} that ${m[2]} ${m[3]} is [___].`;
    }
  }

  // === Pattern 10: "What [noun] does/should/best X verb Y?" ===
  {
    const m = q.match(
      /^What\s+(.*?)\s+(should be|should|best fits|best describes|best explains|best matches|does)\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `The ${m[1]} that ${m[2]} ${m[3]} is [___].`;
    }
  }

  // === "What is/are the X?" → "The X is/are [___]." ===
  {
    const m = q.match(/^What\s+(is|are)\s+the\s+(.*?)\s*\?$/i);
    if (m) {
      return `The ${m[2]} ${m[1]} [___].`;
    }
  }

  // === Pattern N5: "What [noun] must/should/can be [past-participle]?" ===
  // "What diagnosis must be excluded?" → "The diagnosis to exclude is [___]."
  // "What investigation should be ordered?" → "The investigation to order is [___]."
  // We rebuild a clean infinitive form ("to exclude") which reads more
  // naturally than the modal-passive ("that must be excluded").
  {
    const m = q.match(
      /^What\s+(.+?)\s+(?:must|should|can|could|may|might|will|would)\s+be\s+(\w+ed|\w+en|done|started|stopped|given|ordered|excluded|included|considered|avoided|continued|discontinued|initiated)\s*\?$/i
    );
    if (m) {
      const noun = m[1].trim();
      const pastParticiple = m[2].trim().toLowerCase();
      // Map past participle → infinitive where possible
      const infinitives: Record<string, string> = {
        excluded: 'exclude', included: 'include', considered: 'consider',
        avoided: 'avoid', given: 'give', ordered: 'order', done: 'do',
        started: 'start', stopped: 'stop', continued: 'continue',
        discontinued: 'discontinue', initiated: 'initiate',
      };
      const verb = infinitives[pastParticiple] ?? pastParticiple.replace(/(ed|en)$/, '');
      return `The ${noun} to ${verb} is [___].`;
    }
  }

  // === "What is X?" (without "the") → "X is [___]." ===
  {
    const m = q.match(/^What\s+is\s+(.*?)\s*\?$/i);
    if (m) {
      return `${cap(m[1])} is [___].`;
    }
  }

  // === "What are X?" (without "the") → "X are [___]." ===
  {
    const m = q.match(/^What\s+are\s+(.*?)\s*\?$/i);
    if (m) {
      return `${cap(m[1])} are [___].`;
    }
  }

  // === "What does X indicate/suggest/tell?" → "X indicates [___]." ===
  {
    const m = q.match(
      /^What\s+does\s+(.*?)\s+(indicate|suggest|tell you|mean|cause|show|reveal)\s*\?$/i
    );
    if (m) {
      const verb = m[2] === 'tell you' ? 'tells you' : `${m[2]}s`;
      return `${cap(m[1])} ${verb} [___].`;
    }
  }

  // === "What [noun] does the result suggest?" and similar ===
  {
    const m = q.match(
      /^What\s+(.*?)\s+does\s+(.*?)\s+(suggest|indicate|cause|show|predict)\s*\?$/i
    );
    if (m) {
      return `The ${m[1]} ${m[2]} ${m[3]}s is [___].`;
    }
  }

  // === Pattern 3: "How long before X should Y be stopped/held/withheld?" ===
  {
    const m = q.match(
      /^How\s+long\s+before\s+(.*?)\s+should\s+(.*?)\s+be\s+(stopped|held|withheld|discontinued|paused|ceased)\s*\?$/i
    );
    if (m) {
      return `${cap(m[2])} should be ${m[3]} [___] before ${m[1]}.`;
    }
  }

  // === "How much/many X does Y verb?" → "Y verbs [___] of X." ===
  {
    const m = q.match(
      /^(?:Approximately )?[Hh]ow (?:much|many)\s+(.*?)\s+does\s+(.*?)\s+(bind|contain|require|need|deliver|produce)\s*\?$/i
    );
    if (m) {
      return `${cap(m[2])} ${m[3]}s [___] ${m[1]}.`;
    }
  }

  // === "X begins/develops/onsets within how many hours of Y?" ===
  // "Alcohol withdrawal symptoms ... classically begin within how many hours
  //  of the last drink?" → "Alcohol withdrawal symptoms classically begin
  //  within [___] of the last drink."
  // Captures the verb + the prepositional phrase so the cloze reads as a
  // natural statement of the timing.
  {
    const m = q.match(
      /^(.+?)\s+(begin|begins|develop|develops|onsets|present|presents|appear|appears|occur|occurs|peak|peaks)\s+within\s+how\s+many\s+(hours|days|minutes|weeks)\s+(?:after|of)\s+(.+?)\s*\?$/i,
    );
    if (m) {
      const subj = m[1].trim();
      const verb = m[2].trim();
      const ref = m[4].trim();
      return `${cap(subj)} ${verb} within [___] of ${ref}.`.replace(/  +/g, ' ');
    }
  }

  // === "How much/many X?" simple → "The amount of X: [___]." ===
  {
    const m = q.match(
      /^(?:Approximately )?[Hh]ow (?:much|many)\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `${cap(m[1])}: [___].`;
    }
  }

  // === Pattern 4: "Why can't X be Y?" ===
  {
    const m = q.match(
      /^Why\s+can'?t\s+(.*?)\s+be\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `${cap(m[1])} can't be ${m[2]} because [___].`;
    }
  }

  // === Pattern 5: "Why does X not verb Y?" ===
  {
    const m = q.match(
      /^Why\s+does\s+(.*?)\s+not\s+(.*?)\s*\?$/i
    );
    if (m) {
      return `${cap(m[1])} doesn't ${m[2]} because [___].`;
    }
  }

  // === "Why is X [adjective]?" → "X is [adj] because [___]." ===
  {
    const m = q.match(/^Why\s+is\s+(.*?)\s+(misleading|dangerous|important|significant|wrong|incorrect|deceptive)\s*\?$/i);
    if (m) {
      return `${cap(m[1])} is ${m[2]} because [___].`;
    }
  }

  // === "Why is X?" → "X because [___]." ===
  {
    const m = q.match(/^Why\s+is\s+(.*?)\s*\?$/i);
    if (m) {
      return `${cap(m[1])} because [___].`;
    }
  }

  // === Pattern 6: "When is X indicated (in Y)?" ===
  {
    const m = q.match(
      /^When\s+is\s+(.*?)\s+indicated(?:\s+in\s+(.*?))?\s*\?$/i
    );
    if (m) {
      if (m[2]) {
        return `${cap(m[1])} is indicated in ${m[2]} when [___].`;
      }
      return `${cap(m[1])} is indicated when [___].`;
    }
  }

  // === Pattern 6 variant: "When should X be given/administered (in Y)?" ===
  {
    const m = q.match(
      /^When\s+should\s+(.*?)\s+be\s+(?:given|administered)(?:\s+in\s+(.*?))?\s*\?$/i
    );
    if (m) {
      if (m[2]) {
        return `${cap(m[1])} should be given in ${m[2]} when [___].`;
      }
      return `${cap(m[1])} should be given when [___].`;
    }
  }

  // === "When should X be [verb]ed/[verb]en?" (e.g. "When should steroids be started?") ===
  {
    const m = q.match(/^When\s+should\s+(.*?)\s+be\s+(\w+)\s*\?$/i);
    if (m) {
      return `${cap(m[1])} should be ${m[2]} when [___].`;
    }
  }

  // === "When should X?" (catch-all, no "be verb" detected) ===
  {
    const m = q.match(/^When\s+should\s+(.*?)\s*\?$/i);
    if (m) {
      return `${cap(m[1])} should occur when [___].`;
    }
  }

  // === Compound questions "What is X and what does Y?" — take the first part ===
  {
    const m = q.match(/^(.*?)\s+and\s+what\s+(?:does|is|are)\s+(.*?)\s*\?$/i);
    if (m) {
      // Try converting just the first half
      const first = m[1].trim() + '?';
      const converted = questionToStatement(first);
      if (!converted.endsWith(': [___].')) {
        return converted;
      }
    }
  }

  // === Fallback: strip question mark and trailing punctuation, make it a statement ===
  const stripped = q.replace(/\?$/, '').replace(/[.:;,]+$/, '').trim();
  // If it starts with "What/Which/How/When/Why", rewrite minimally
  if (/^(?:What|How|When|Why)\s/i.test(stripped)) {
    return `${stripped}: [___].`;
  }
  return `${stripped}: [___].`;
}

function cap(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
