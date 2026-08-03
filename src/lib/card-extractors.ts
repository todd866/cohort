/**
 * Card Extractors - Extraction logic for different card types from MDX components
 *
 * Extraction policy: EXPLICIT Q&A ONLY (no auto-blank from bold terms)
 *
 * Extracts from:
 * - <Mnemonic> -> One card per line item (answer is bolded term)
 * - <KeyPoint> -> Card from Q:/A: format only
 * - <Danger> -> Card from Q:/A: format only
 * - <ClinicalPearl> -> Card from Q:/A: format only
 *
 * KeyPoint/Danger/ClinicalPearl components without Q&A format are
 * treated as teaching-only and produce no card. The previous bold-term-blank
 * fallback was removed because it generated low-quality "guess which word
 * was bold" cloze cards.
 */

import type { GeneratedCard } from './card-generator';
import { trimAnswerAtMarkdownBoundary } from './qa-boundaries';

// ---------------------------------------------------------------------------
// Extraction stats — tracks teaching-only component skips for seed reporting
// ---------------------------------------------------------------------------
export interface ExtractionStats {
  keyPointTotal: number;
  keyPointSkipped: number;
  dangerTotal: number;
  dangerSkipped: number;
  clinicalPearlTotal: number;
  clinicalPearlSkipped: number;
  // Context-quality violations on cloze cards generated from
  // KeyPoint/Danger/ClinicalPearl. Counted at extract time so the seed log
  // surfaces the gap; the same helpers are used by the systemic audit.
  clozeMissingContext: number;
  clozeStubContext: number;
  clozeRestatesAnswer: number;
}

let _stats: ExtractionStats = {
  keyPointTotal: 0, keyPointSkipped: 0,
  dangerTotal: 0, dangerSkipped: 0,
  clinicalPearlTotal: 0, clinicalPearlSkipped: 0,
  clozeMissingContext: 0, clozeStubContext: 0, clozeRestatesAnswer: 0,
};

export function resetExtractionStats(): void {
  _stats = {
    keyPointTotal: 0, keyPointSkipped: 0,
    dangerTotal: 0, dangerSkipped: 0,
    clinicalPearlTotal: 0, clinicalPearlSkipped: 0,
    clozeMissingContext: 0, clozeStubContext: 0, clozeRestatesAnswer: 0,
  };
}

export function getExtractionStats(): ExtractionStats {
  return { ..._stats };
}

// ---------------------------------------------------------------------------
// Context-quality helpers
// Used by both the extractor (counted at seed time) and the systemic audit
// (emits ContentIssue rows). A "good" context teaches WHY/WHEN/TRAP — these
// helpers detect the three most common failure modes.
// ---------------------------------------------------------------------------

/** True when the card has no usable teaching context. */
export function isMissingContext(ctx: string | null | undefined): boolean {
  if (ctx == null) return true;
  return ctx.trim().length === 0;
}

/**
 * True when the context is a meaningless placeholder — most commonly an
 * acronym-definition stub ("MCD = minimal change disease.") or one of the
 * placeholders left by older pipelines ("See per-option explanations.").
 *
 * Acronym decoding belongs in the <Term> hover UX, not in the context slot.
 *
 * Tightening rules (vs an earlier overly-greedy version):
 *   - Acronym prefix must be all-caps + digits (`MCD`, `MAOI`, `H2O2`),
 *     not arbitrary capitalised words (`Treatment:` is a label, not an
 *     acronym definition).
 *   - The stub must be a single sentence. A context that begins with an
 *     acronym definition and continues with real teaching ("MAOI = ... .
 *     The cheese reaction occurs because ...") is acceptable — the prefix
 *     is just hover-decode redundancy, not a stub.
 */
export function isStubContext(ctx: string | null | undefined): boolean {
  if (ctx == null) return false;
  const trimmed = ctx.trim();
  if (trimmed.length === 0) return false;
  // Known meaningless placeholders — match these regardless of length.
  if (/^(?:see\s+per[-\s]option(?:\s+explanations?)?|see\s+options?|see\s+(?:above|below)|see\s+explanations?|n\/?a)\.?$/i.test(trimmed)) return true;
  // Acronym = expansion patterns. Strip a single trailing period, then refuse
  // to flag if there's a sentence boundary (period + whitespace + non-empty)
  // which signals additional teaching.
  const stripped = trimmed.replace(/\.\s*$/, '');
  if (/\.\s+\S/.test(stripped)) return false; // multi-sentence — not a stub
  //   "MCD = minimal change disease"
  //   "PDA: patent ductus arteriosus"
  //   "RSV stands for respiratory syncytial virus"
  //   "NEC means necrotising enterocolitis"
  const definition = stripped.match(/^([A-Z][A-Z0-9]{1,9})\s*(=|:|\bstands for\b|\bmeans\b)\s+(.+)$/);
  if (definition) {
    const [, , operator, rhs] = definition;
    if (/\b(?:stands for|means)\b/i.test(operator)) return true;
    // Colon/equal contexts can be real mnemonic maps rather than empty acronym
    // expansions, e.g. "ROME: Respiratory = Opposite..." or
    // "WILLIAM: W in V1, M in V6." Keep those because they teach how to use
    // the mnemonic. Plain lowercase expansions remain stubs.
    if (/^[A-Za-z][A-Za-z\s'’/-]+$/.test(rhs.trim())) return true;
  }
  return false;
}

/**
 * True when the context is essentially a restatement of the answer — the
 * answer appears in the context and the context isn't much longer than the
 * answer (so it's not adding teaching, just echoing).
 */
export function restatesAnswer(
  ctx: string | null | undefined,
  answer: string | null | undefined,
): boolean {
  if (!ctx || !answer) return false;
  const c = ctx.trim().toLowerCase();
  const a = answer.trim().toLowerCase();
  if (c.length === 0 || a.length === 0) return false;
  if (!c.includes(a)) return false;
  // Allow some teaching budget on top of the answer — context must be at
  // least ~2x the answer's length AND add at least ~80 extra chars to count
  // as adding teaching beyond the restatement.
  return c.length < Math.max(a.length * 2, a.length + 80);
}

/** Increment the context-quality counters for a single emitted cloze card. */
function tallyContextQuality(ctx: string | null | undefined, answer: string): void {
  if (isMissingContext(ctx)) {
    _stats.clozeMissingContext++;
    return;
  }
  if (isStubContext(ctx)) {
    _stats.clozeStubContext++;
    return;
  }
  if (restatesAnswer(ctx, answer)) {
    _stats.clozeRestatesAnswer++;
  }
}

/**
 * Auto-split a single-blank cloze card with a list answer into multi-cloze.
 *
 * If the card has a single [___] blank and the answer is a comma/semicolon-separated
 * list of 3+ short items (each 1-4 words), replace the single blank with N blanks
 * and set the backs array.
 *
 * Returns null if the card should not be split.
 */
export function splitListAnswerToMultiCloze(
  card: { front: string; back: string; backs?: string[] | null; cardType: string }
): { front: string; back: string; backs: string[] } | null {
  // Only process cloze cards
  if (card.cardType !== 'cloze') return null;

  // Skip if already multi-cloze
  if (card.backs && card.backs.length > 1) return null;

  // Must have exactly one blank
  const blankCount = (card.front.match(/\[___\]/g) ?? []).length;
  if (blankCount !== 1) return null;

  // Split by comma or semicolon
  const items = card.back
    .split(/[,;]/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // Need 3+ items
  if (items.length < 3) return null;

  // Each item must be 1-4 words (short enough for a blank)
  const allShort = items.every(item => {
    const wordCount = item.split(/\s+/).length;
    return wordCount >= 1 && wordCount <= 4;
  });
  if (!allShort) return null;

  // Build multi-cloze front: replace single [___] with N blanks
  const blanks = items.map(() => '[___]').join(', ');
  const front = card.front.replace('[___]', blanks);

  return {
    front,
    back: card.back, // Keep original as fallback
    backs: items,
  };
}

/**
 * Extract the week number from a filename like "week1-resuscitation.mdx"
 * Returns null for filenames without a week number (e.g. "biochemistry.mdx")
 */
export function extractWeekFromFilename(filename: string): number | null {
  const match = filename.match(/week(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Calculate complexity score for a card based on its characteristics
 *
 * 1 = Trivial: Single letter mnemonic, 1-2 word answer, direct lookup
 * 2 = Moderate: KeyPoint cloze, drug doses, some context needed
 * 3 = Complex: MCQ, clinical reasoning, multi-step
 */
function calculateComplexity(
  sourceComponent: 'Mnemonic' | 'KeyPoint' | 'MCQ' | 'Danger' | 'ClinicalPearl',
  answer: string,
  front: string
): 1 | 2 | 3 {
  // MCQs are always complex - they require reasoning
  if (sourceComponent === 'MCQ') {
    return 3;
  }

  const answerWordCount = answer.trim().split(/\s+/).length;
  const hasNumbers = /\d/.test(answer);
  const hasUnits = /\b(mg|mL|mmol|mmHg|%|kg|cm|mm|bpm|min|sec|hours?|minutes?|days?|weeks?)\b/i.test(answer);

  // Mnemonic cards
  if (sourceComponent === 'Mnemonic') {
    // Single letter standing for a word = trivial
    // e.g., "COACHED: 'A' stands for [___]" -> "All else clear"
    const isSingleLetterMnemonic = /stands for \[___\]/.test(front);

    if (isSingleLetterMnemonic && answerWordCount <= 3) {
      return 1; // Trivial: memorizing what a letter stands for
    }

    // Longer mnemonic answers or those with clinical detail
    if (answerWordCount > 3 || hasNumbers || hasUnits) {
      return 2; // Moderate: requires more context
    }

    return 1; // Default mnemonic = trivial
  }

  // KeyPoint cards
  //
  // Default to C2 (moderate). The previous heuristic downgraded any KeyPoint
  // with a ≤2-word non-numeric answer to C1, on the assumption that "short
  // answer = trivial." Empirically wrong: PAAM stuanki imports proved this
  // (608 of 658 C1-by-heuristic cards tested at C2 facility — see
  // audit/complexity-calibration/snapshots.jsonl 2026-05-16 + the bulk
  // re-label that followed). Short definitional answers ("adjustment
  // disorder", "thiamine", "6 months") are exactly the C2 band — testing
  // a specific clinical fact someone has to *know*, not scaffolding for
  // a naive concept.
  //
  // True C1 scaffolds need to be either:
  //   - explicitly tagged via `complexity={1}` on the source <KeyPoint>
  //   - or in `complexity=1` topic files (anki-scaffold-*)
  // The empirical-aggregation cron + audit:complexity-calibration tools
  // surface the empirical band when sample size permits; the bulk
  // re-label script re-tiers based on that signal.
  if (sourceComponent === 'KeyPoint') {
    return 2;
  }

  return 2; // Fallback
}

// =============================================================================
// Topic extraction helpers
// =============================================================================

export type Heading = { index: number; level: number; text: string; topics: string[] };

const HEADING_IGNORE_TITLES = new Set([
  'practice questions',
  'test your knowledge',
  'overview',
  'key facts',
  'definition',
  'sources',
  'related topics',
  'references',
  // Section labels for in-file MCQ blocks / quick-reference tables — these
  // are structural, not clinical topics. Without ignoring them the primary
  // phrase emits as a topic on every card under the heading.
  'mcqs',
  'mcq',
  'quick reference',
  'high-yield drill',
  'high yield drill',
  'rapid recall',
  'rapid review',
  'summary',
  'recap',
  'self test',
  'self-test',
  'self assessment',
  'self-assessment',
]);

const WORD_STOPLIST = new Set([
  'and',
  'or',
  'the',
  'a',
  'an',
  'of',
  'to',
  'for',
  'in',
  'on',
  'with',
  'without',
  'vs',
  'versus',
  'management',
  'assessment',
  'approach',
  'overview',
  'basics',
  'guide',
  'numbers',
  'practice',
  'questions',
  'notes',
  // Structural scaffolding words — appear in many headings as section labels
  // rather than clinical concepts. Emitting them as topic strings produces
  // noisy matches that don't help card↔bank-question pairing.
  'classification',
  'cluster',
  'clusters',
  'core',
  'detail',
  'details',
  'boundary',
  'boundaries',
  'domain',
  'domains',
  'severity',
  'severities',
  'subtype',
  'subtypes',
  'feature',
  'features',
  'criterion',
  'criteria',
  'principle',
  'principles',
  'factor',
  'factors',
  'role',
  'roles',
  'level',
  'levels',
  'type',
  'types',
  'kind',
  'kinds',
  'mode',
  'modes',
  'option',
  'options',
  'risk',
  'risks',
  'summary',
  'additional',
  'sample',
  'samples',
  'example',
  'examples',
  'table',
  'tables',
  'list',
  'lists',
  'common',
  'general',
  'specific',
  'introduction',
  'background',
  'mcq',
  'mcqs',
  'pearl',
  'pearls',
  'tip',
  'tips',
  'trait',
  'traits',
  'significance',
  'prognostic',
  'prevention',
  'detection',
  'diagnosis',
  // Section-quality / utility scaffolding
  'high',
  'low',
  'yield',
]);

function dedupeTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of topics) {
    const t = raw.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    result.push(t);
  }
  return result;
}

function cleanHeadingText(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, '') // trailing "###"
    // Strip rotation-prefixed week labels: "Paam Week 3", "Critical Care Week 1",
    // "Cah Week 5", "PWH Week 2" — these are file-level scaffolding, not clinical
    // topics, but the heading "## Paam Week 3 — StuAnki Cards" otherwise emits
    // "Paam Week 3" as a topic on every card in the file.
    .replace(/^(Paam|PAAM|Cah|CAH|Pwh|PWH|Critical\s*Care|CC)\s+Week\s*\d+\s*[:.\-–—]?\s*/i, '')
    .replace(/^Week\s*\d+\s*[:.\-–—]\s*/i, '') // "Week 1: ..."
    .replace(/^\d+(?:\.\d+)*[.)]?\s+/, '') // "1. ..." / "2) ...")
    .trim();
}

/**
 * Strip MDX components from text, keeping only the display text
 * - <WikiLink slug="...">Display Text</WikiLink> -> Display Text
 * - <Term abbr="ABC" /> -> ABC
 * - <Term abbr="ABC">Full Name</Term> -> Full Name
 * - HTML entities (&lt; &gt; &amp;) -> decoded characters
 */
/**
 * Normalize context strings: collapse mid-sentence \n\n to single space.
 * Preserves intentional paragraph breaks (after sentence-ending punctuation).
 */
export function normalizeContext(text: string): string {
  return text
    // Collapse mid-sentence double newlines to single space
    .replace(/([a-z,;)\u2019\u201d])\n\n([a-z])/g, '$1 $2')
    // Collapse multiple spaces
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function stripMdxComponents(text: string): string {
  return text
    // Strip <LearnMore>...</LearnMore> blocks entirely (supplementary content, not card text)
    .replace(/<LearnMore[\s\S]*?<\/LearnMore>/g, '')
    // Strip "Source: ..." attribution lines (not card content)
    .replace(/^Source:.*$/gm, '')
    .replace(/\nSource:.*$/gm, '')
    // <WikiLink slug="...">content</WikiLink> -> content
    .replace(/<WikiLink[^>]*>([^<]*)<\/WikiLink>/g, '$1')
    // <Term abbr="ABC" /> -> ABC
    .replace(/<Term\s+abbr="([^"]+)"\s*\/>/g, '$1')
    // <Term abbr="ABC">Full Name</Term> -> Full Name
    .replace(/<Term[^>]*>([^<]*)<\/Term>/g, '$1')
    // Any remaining self-closing tags
    .replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, '')
    // Any remaining component tags
    .replace(/<\/?[A-Z][a-zA-Z]*[^>]*>/g, '')
    // Decode HTML entities
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    // Normalize JSX expression escapes: {'<'} -> < and {'>'} -> >
    .replace(/\{\s*['"]\s*([<>])\s*['"]\s*\}/g, '$1')
    // Normalize backslash escapes from MDX: \< -> <, \> -> >, \* -> *
    .replace(/\\([<>*_])/g, '$1')
    // Normalize escaped cloze blanks: [\_\_\_] -> [___]
    .replace(/\[\\_\\_\\_\]/g, '[___]')
    .trim();
}

export function parseQAPairs(content: string): Array<{ question: string; answer: string }> {
  const qaRegex = /\*\*Q:\*\*\s*([\s\S]*?)\s*\*\*A:\*\*\s*([\s\S]*?)(?=\s*\*\*Q:\*\*|\s*$)/gi;
  const pairs: Array<{ question: string; answer: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = qaRegex.exec(content)) !== null) {
    const question = m[1].trim();
    // Stop at the first markdown block boundary so teaching bullets/headings
    // do not get swallowed into the memorized answer.
    const rawAnswer = m[2].trim();
    const answer = trimAnswerAtMarkdownBoundary(rawAnswer);
    pairs.push({ question, answer });
  }
  return pairs;
}

/**
 * Split multi-blank answers and align to blank count.
 * - If blankCount <= 1: returns single-answer (no backs array)
 * - If parts match blankCount: returns backs array
 * - If parts > blankCount: truncates to blankCount
 * - If parts < blankCount: falls back to single-answer (mismatch means MDX needs fixing)
 */
export function alignMultiBlankAnswers(
  answerPart: string,
  blankCount: number
): { back: string; backs?: string[] } {
  if (blankCount <= 1) {
    return { back: answerPart };
  }

  const parts = answerPart.split(/[;\n]/).map(a => a.trim()).filter(a => a.length > 0);

  if (parts.length >= blankCount) {
    // Truncate to match blank count
    const aligned = parts.slice(0, blankCount);
    return { back: aligned[0], backs: aligned };
  }

  // Fewer parts than blanks — can't align, fall back to single answer
  return { back: parts[0] ?? answerPart };
}

/**
 * Strip emoji/label prefixes from card front text.
 * Removes patterns like "💡 PEARL:", "⚠️ DANGER:", "🔑 KEY:", and plain-text equivalents.
 */
export function stripCardPrefixes(text: string): string {
  return text
    .replace(/^💡\s*PEARL:\s*/u, '')
    .replace(/^⚠️\s*DANGER:\s*/u, '')
    .replace(/^🔑\s*KEY:\s*/u, '')
    .replace(/^PEARL:\s*/i, '')
    .replace(/^DANGER:\s*/i, '')
    .replace(/^KEY:\s*/i, '')
    .trim();
}

function extractStringAttr(attrs: string, name: string): string | undefined {
  // Allow escaped quotes (\" and \') inside the quoted value — otherwise a
  // context like ...inspiratory \"whoop\"... truncates at the first \", dropping
  // the teaching tail and tripping restates-answer/stub-context at seed time.
  const pattern = new RegExp(
    `${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`,
  );
  const match = attrs.match(pattern);
  const raw = match?.[1] ?? match?.[2];
  if (!raw || raw.trim().length === 0) return undefined;
  // Unescape JSX string escape sequences (literal \n, \t, \", \' stored as two chars)
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .trim();
}

/** Extract a JSX numeric attribute like importance={3} */
function extractNumberAttr(attrs: string, name: string): number | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*\\{\\s*(\\d+)\\s*\\}`);
  const match = attrs.match(pattern);
  return match ? parseInt(match[1], 10) : undefined;
}

function topicsFromHeadingText(raw: string): string[] {
  // Strip embedded MDX (<Term abbr="MSE" />, <WikiLink>…</WikiLink>) before
  // tokenising. Otherwise component-attribute names like `abbr` and `Term`
  // leak into the word list and produce phantom acronyms (e.g. "MSETAM"
  // from a heading containing <Term abbr="MSE" />).
  const cleaned = cleanHeadingText(stripMdxComponents(raw));
  if (!cleaned) return [];
  if (HEADING_IGNORE_TITLES.has(cleaned.toLowerCase())) return [];

  const primary = cleaned.split(/[:–—-]/)[0]?.trim() ?? cleaned;
  if (!primary) return [];

  const topics = new Set<string>();

  // Chapter titles like "Cardiology, Developmental, Dermatology & Endocrinology"
  // are multi-topic lists, not single phrase topics. Detect via simultaneous
  // comma + `&` (or " and ") and split into individual topics. Single-comma
  // phrases like "Pain, fever and reassurance" stay as one (no `&`).
  const isMultiTopicList =
    /,/.test(primary) && /(?:\s+&\s+|\s+and\s+)/.test(primary);
  if (isMultiTopicList) {
    const parts = primary
      .split(/\s*,\s*|\s+&\s+|\s+and\s+/i)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const p of parts) topics.add(p);
  } else {
    // Add the primary phrase (helps when concepts use phrase topics like "Respiratory Failure")
    topics.add(primary);
  }

  // Add obvious abbreviations already present (BLS, CPR, VF, ABG, etc.)
  for (const match of primary.matchAll(/\b[A-Z][A-Z0-9]{1,}\b/g)) {
    topics.add(match[0]);
  }

  // Add key words from the heading (Airway, Shock, Fluids, etc.)
  const words = primary.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (const word of words) {
    const lower = word.toLowerCase();
    if (WORD_STOPLIST.has(lower)) continue;
    if (word.length < 3) continue;
    // Skip generic numbers-only tokens
    if (!/[A-Za-z]/.test(word)) continue;
    // Skip section-numbering tokens like "13b" or "1a" — these are heading
    // numerals, not topic tokens. The extractor would otherwise emit them as
    // topic strings (e.g. "13b" appeared as a paam topic).
    if (/^\d+[a-z]?$/i.test(word)) continue;
    topics.add(word);
  }

  // (Synthesised acronyms from word initials are intentionally OFF — they
  // produced junk topics like "BPDD" from "Borderline Personality Disorder
  // in Detail". Real acronyms come through the all-caps regex above when
  // authors write them explicitly, e.g. "Borderline Personality Disorder
  // (BPD)".)

  return [...topics];
}

export function extractHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  const pattern = /^(#{1,6})\s+(.+?)\s*$/gm;
  for (const match of content.matchAll(pattern)) {
    const level = match[1]?.length ?? 0;
    const rawText = match[2] ?? '';
    const index = match.index ?? 0;
    const topics = topicsFromHeadingText(rawText);
    headings.push({ index, level, text: rawText.trim(), topics });
  }
  return headings.sort((a, b) => a.index - b.index);
}

/**
 * Walk ancestor headings backward from a position in the document.
 * Collects the closest heading at each level, climbing toward h1.
 * The visitor receives each ancestor heading (nearest first) and can
 * return false to skip it (e.g. when topics are empty).
 */
function walkAncestorHeadings(
  headings: Heading[],
  index: number,
  visit: (h: Heading) => void,
): void {
  let currentLevel = Infinity;
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    if (h.index >= index) continue;
    if (h.level >= currentLevel) continue;
    currentLevel = h.level;
    visit(h);
    if (currentLevel <= 1) break;
  }
}

function topicsForIndex(headings: Heading[], index: number): string[] {
  if (headings.length === 0) return [];
  const collected: string[] = [];
  walkAncestorHeadings(headings, index, (h) => {
    collected.push(...h.topics);
  });
  return dedupeTopics(collected);
}

/**
 * Mnemonic blocks render as teaching-only content. They no longer auto-generate
 * flashcards.
 *
 * Why this is disabled: the previous behaviour produced multi-blank cloze cards
 * like `TEN-4: T=[___], E=[___], N=[___], 4=[___]` which violate every
 * card-quality rule — the cued letter is a giveaway, multi-blank scoring is
 * brittle, the answers were typically multi-word ("Age cutoffs below"), and a
 * generic "Use the X mnemonic as a structured recall aid…" context was emitted
 * when the author hadn't supplied one (taught nothing).
 *
 * If an author wants test cards on a mnemonic's content, they author proper
 * <KeyPoint> Q&A blocks alongside the <Mnemonic> block, with real teaching
 * context attached.
 */
export function extractMnemonicCards(
  _content: string,
  _rotation: string,
  _week: number | null,
  _headings: Heading[]
): GeneratedCard[] {
  void _content;
  void _rotation;
  void _week;
  void _headings;
  return [];
}

/**
 * Generic extractor for Q&A-based components (KeyPoint, Danger, ClinicalPearl).
 * All three share the same extraction logic — only the tag name, source component
 * label, complexity calculation, and stats keys differ.
 */
function extractComponentCards(
  content: string,
  rotation: string,
  week: number | null,
  headings: Heading[],
  config: {
    tagName: string;
    sourceComponent: 'KeyPoint' | 'Mnemonic' | 'MCQ' | 'Danger' | 'ClinicalPearl';
    getComplexity: (back: string, front: string) => 1 | 2 | 3;
    statTotal: keyof typeof _stats;
    statSkipped: keyof typeof _stats;
  },
): GeneratedCard[] {
  const cards: GeneratedCard[] = [];

  const tagRegex = new RegExp(
    `<${config.tagName}((?:[^>"]|"[^"]*")*)>([\\s\\S]*?)<\\/${config.tagName}>`, 'g'
  );

  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    (_stats[config.statTotal] as number)++;
    const attrs = match[1] ?? '';
    const innerContent = match[2].trim();
    const headingTopics = topicsForIndex(headings, match.index ?? 0);
    const contextOverride = extractStringAttr(attrs, 'context');
    // Previously we fell back to a heading-path breadcrumb
    // (e.g. "Week 1: Resuscitation > 7. ECG Interpretation > ..."), which
    // rendered as same-across-N-cards boilerplate that taught nothing. If
    // the author didn't write an explicit context=, leave it empty.
    const resolvedContext = contextOverride
      ? normalizeContext(stripMdxComponents(contextOverride))
      : undefined;
    const learnMore = extractStringAttr(attrs, 'learnMore');
    const crosslinks = learnMore ? { primary: learnMore } : null;
    const jurisdiction = extractStringAttr(attrs, 'jurisdiction');
    const cite = extractStringAttr(attrs, 'cite');
    const conceptId = extractStringAttr(attrs, 'concept');
    const clusterId = extractStringAttr(attrs, 'clusterId');
    const imageUrl = extractStringAttr(attrs, 'image') ?? extractStringAttr(attrs, 'imageUrl');
    const imageCaption = extractStringAttr(attrs, 'imageCaption') ?? extractStringAttr(attrs, 'caption');
    // 'prompt' = the image IS the card stem (image-as-prompt, copyright-tier
    // only). A query/gate flag; render placement is driven by the sidecar.
    const imageRole = extractStringAttr(attrs, 'imageRole');
    const importance = extractNumberAttr(attrs, 'importance') as 1 | 2 | 3 | undefined;
    // Author-supplied complexity override. KeyPoint cards default to C2 (see
    // calculateComplexity); the heuristic can't tell a naive-concept scaffold
    // from a moderate recall fact. An explicit `complexity={1}` on the source
    // <KeyPoint> is the documented way to author a C1 teaching scaffold (and
    // {3} a stretch card). Only 1–3 are honored; anything else falls back to
    // the per-component heuristic.
    const complexityAttr = extractNumberAttr(attrs, 'complexity');
    const complexityOverride =
      complexityAttr === 1 || complexityAttr === 2 || complexityAttr === 3
        ? (complexityAttr as 1 | 2 | 3)
        : undefined;

    // Parse all Q&A pairs (handles multiple per component, trims trailing notes)
    const qaPairs = parseQAPairs(innerContent);
    if (qaPairs.length > 0) {
      for (const { question, answer } of qaPairs) {
        const questionPart = stripCardPrefixes(question);
        const answerPart = answer;

        const hasCloze = /\[\.\.\.\]|\[___\]|\[\\_\\_\\_\]/.test(questionPart);

        if (hasCloze) {
          const front = questionPart.replace(/\[\.\.\.\]/g, '[___]').replace(/\[\\_\\_\\_\]/g, '[___]');
          const blankCount = (front.match(/\[___\]/g) ?? []).length;
          const { back: alignedBack, backs: alignedBacks } = alignMultiBlankAnswers(answerPart, blankCount);

          tallyContextQuality(resolvedContext, alignedBack);
          cards.push({
            cardType: 'cloze',
            rotation,
            week,
            sourceComponent: config.sourceComponent,
            imageUrl,
            imageCaption,
            imageRole,
            front: stripMdxComponents(front),
            back: stripMdxComponents(alignedBack),
            backs: alignedBacks ? alignedBacks.map(stripMdxComponents) : undefined,
            context: resolvedContext,
            crosslinks,
            topics: dedupeTopics(headingTopics),
            complexity: complexityOverride ?? config.getComplexity(alignedBack, front),
            importance,
            jurisdiction,
            cite,
            conceptId,
            clusterId,
          });
        } else {
          tallyContextQuality(resolvedContext, answerPart);
          cards.push({
            cardType: 'cloze',
            rotation,
            week,
            sourceComponent: config.sourceComponent,
            imageUrl,
            imageCaption,
            imageRole,
            front: stripMdxComponents(questionPart) + ' [___]',
            back: stripMdxComponents(answerPart),
            context: resolvedContext,
            crosslinks,
            topics: dedupeTopics(headingTopics),
            complexity: complexityOverride ?? config.getComplexity(answerPart, questionPart),
            importance,
            jurisdiction,
            cite,
            conceptId,
            clusterId,
          });
        }
      }
      continue; // Skip — Q&A already handled
    }

    // Fallback: inline cloze format — has [___] blanks and **A:** but no **Q:** prefix.
    // e.g. "**MDE** requires [___] or more symptoms. **A:** 5"
    const strippedInner = stripMdxComponents(innerContent);
    const hasCloze = /\[___\]/.test(strippedInner);
    const inlineAnswerMatch = strippedInner.match(/^([\s\S]*?)\s*\*\*A:\*\*\s*([\s\S]*?)$/);
    if (hasCloze && inlineAnswerMatch) {
      const questionPart = stripCardPrefixes(inlineAnswerMatch[1].trim());
      const rawAnswer = trimAnswerAtMarkdownBoundary(inlineAnswerMatch[2].trim());

      const front = questionPart.replace(/\[\.\.\.\]/g, '[___]');
      const blankCount = (front.match(/\[___\]/g) ?? []).length;
      const { back: alignedBack, backs: alignedBacks } = alignMultiBlankAnswers(rawAnswer, blankCount);

      tallyContextQuality(resolvedContext, alignedBack);
      cards.push({
        cardType: 'cloze',
        rotation,
        week,
        sourceComponent: config.sourceComponent,
        imageUrl,
        imageCaption,
        front: stripMdxComponents(front),
        back: stripMdxComponents(alignedBack),
        backs: alignedBacks ? alignedBacks.map(stripMdxComponents) : undefined,
        context: resolvedContext,
        crosslinks,
        topics: dedupeTopics(headingTopics),
        complexity: complexityOverride ?? config.getComplexity(alignedBack, front),
        importance,
        jurisdiction,
        cite,
        conceptId,
        clusterId,
      });
      continue;
    }

    (_stats[config.statSkipped] as number)++;
  }

  return cards;
}

/** Extract cards from <KeyPoint> components */
export function extractKeyPointCards(
  content: string, rotation: string, week: number | null, headings: Heading[]
): GeneratedCard[] {
  return extractComponentCards(content, rotation, week, headings, {
    tagName: 'KeyPoint',
    sourceComponent: 'KeyPoint',
    getComplexity: (back, front) => calculateComplexity('KeyPoint', back, front) as 1 | 2 | 3,
    statTotal: 'keyPointTotal',
    statSkipped: 'keyPointSkipped',
  });
}

/** Extract cards from <Danger> components */
export function extractDangerCards(
  content: string, rotation: string, week: number | null, headings: Heading[]
): GeneratedCard[] {
  return extractComponentCards(content, rotation, week, headings, {
    tagName: 'Danger',
    sourceComponent: 'Danger',
    getComplexity: () => 2 as const,
    statTotal: 'dangerTotal',
    statSkipped: 'dangerSkipped',
  });
}

/** Extract cards from <ClinicalPearl> components */
export function extractClinicalPearlCards(
  content: string, rotation: string, week: number | null, headings: Heading[]
): GeneratedCard[] {
  return extractComponentCards(content, rotation, week, headings, {
    tagName: 'ClinicalPearl',
    sourceComponent: 'ClinicalPearl',
    getComplexity: () => 2 as const,
    statTotal: 'clinicalPearlTotal',
    statSkipped: 'clinicalPearlSkipped',
  });
}
