/**
 * Option Guessability Analyzer
 *
 * Detects patterns that make MCQ answers guessable without medical knowledge.
 * Test-wise students learn to spot these tells - we need to eliminate them.
 *
 * Key patterns:
 * 1. Length asymmetry - correct is longest/shortest
 * 2. Qualifier asymmetry - correct hedges more ("usually", "typically")
 * 3. Absolute terms - distractors use "always", "never" (classic trap)
 * 4. Specificity asymmetry - correct is more/less detailed
 * 5. Parenthetical tells - only correct has "(e.g., X)"
 * 6. Linguistic sophistication - terminology density varies
 */

export interface GuessabilityProfile {
  // Overall guessability score (0-1, higher = more guessable)
  score: number;

  // Individual signal scores
  signals: {
    lengthAsymmetry: number;
    qualifierAsymmetry: number;
    absoluteTermTrap: number;
    specificityAsymmetry: number;
    parentheticalTell: number;
    sophisticationAsymmetry: number;
  };

  // Human-readable issues
  issues: string[];

  // Which option is likely guessable as correct (if any)
  likelyCorrectByTell: string | null;
}

interface Option {
  label: string;
  text: string;
  isCorrect?: boolean;
}

// Hedging/qualifier patterns (suggest careful, accurate answer)
const QUALIFIER_PATTERNS = [
  /\b(usually|typically|often|generally|commonly|frequently)\b/gi,
  /\b(in most cases|most likely|most commonly)\b/gi,
  /\b(may|might|can|could)\b/gi,
  /\b(tends to|is likely to)\b/gi,
  /\b(approximately|about|around)\b/gi,
];

// Absolute terms (often mark wrong answers - "too absolute to be true")
const ABSOLUTE_PATTERNS = [
  /\b(always|never|only|all|none|every|no)\b/gi,
  /\b(must|cannot|will not|definitely)\b/gi,
  /\b(exclusively|invariably|absolutely)\b/gi,
];

// Parenthetical explanations (often appear in correct answers)
const PARENTHETICAL_PATTERN = /\([^)]+\)/g;

// Specific detail patterns (numbers, dosages, timeframes)
const SPECIFICITY_PATTERNS = [
  /\d+\s*(?:mg|mcg|g|mL|L|mmol|mEq|units?|IU)/gi, // Dosages
  /\d+\s*(?:hours?|days?|weeks?|months?|years?)/gi, // Timeframes
  /\d+(?:\.\d+)?%/g, // Percentages
  /\d+-\d+/g, // Ranges
];

// Medical terminology indicators (higher density = more sophisticated)
const MEDICAL_TERM_PATTERNS = [
  /\b\w+(?:itis|osis|emia|uria|pathy|trophy|plasia|ectomy|otomy|plasty)\b/gi,
  /\b(?:hyper|hypo|anti|pre|post|peri|intra|extra)\w+/gi,
  /\b[A-Z]{2,5}\b/g, // Acronyms like ECG, CT, MRI
];

/**
 * Count pattern matches in text
 */
function countMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    count += matches?.length || 0;
  }
  return count;
}

/**
 * Calculate length asymmetry score
 * Returns 0-1 where higher = more asymmetric = more guessable
 */
function analyzeLengthAsymmetry(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const lengths = options.map((o) => ({ label: o.label, len: o.text.length }));
  const mean = lengths.reduce((s, o) => s + o.len, 0) / lengths.length;
  const variance = lengths.reduce((s, o) => s + Math.pow(o.len - mean, 2), 0) / lengths.length;
  const stddev = Math.sqrt(variance);
  const cv = mean > 0 ? stddev / mean : 0;

  // Find extreme options
  const sorted = [...lengths].sort((a, b) => a.len - b.len);
  const shortest = sorted[0];
  const longest = sorted[sorted.length - 1];

  // Check if one option is significantly different
  const shortestZScore = mean > 0 ? (shortest.len - mean) / (stddev || 1) : 0;
  const longestZScore = mean > 0 ? (longest.len - mean) / (stddev || 1) : 0;

  let issue: string | null = null;
  let likelyCorrect: string | null = null;

  if (cv > 0.4) {
    // High variance
    if (Math.abs(shortestZScore) > 1.5) {
      issue = `Option ${shortest.label} is much shorter than others`;
      likelyCorrect = shortest.label;
    } else if (Math.abs(longestZScore) > 1.5) {
      issue = `Option ${longest.label} is much longer than others`;
      likelyCorrect = longest.label;
    } else {
      issue = 'High length variance across options';
    }
  }

  return { score: Math.min(1, cv), issue, likelyCorrect };
}

/**
 * Analyze qualifier/hedging language asymmetry
 */
function analyzeQualifierAsymmetry(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const counts = options.map((o) => ({
    label: o.label,
    count: countMatches(o.text, QUALIFIER_PATTERNS),
  }));

  const total = counts.reduce((s, o) => s + o.count, 0);
  if (total === 0) return { score: 0, issue: null, likelyCorrect: null };

  // Find option with most qualifiers
  const sorted = [...counts].sort((a, b) => b.count - a.count);
  const highest = sorted[0];
  const secondHighest = sorted[1];

  // Check if one option dominates
  if (highest.count > 0 && secondHighest.count === 0) {
    return {
      score: 0.8,
      issue: `Only option ${highest.label} uses hedging language`,
      likelyCorrect: highest.label,
    };
  }

  if (highest.count >= 3 && highest.count > secondHighest.count * 2) {
    return {
      score: 0.6,
      issue: `Option ${highest.label} hedges much more than others`,
      likelyCorrect: highest.label,
    };
  }

  return { score: 0, issue: null, likelyCorrect: null };
}

/**
 * Analyze absolute term usage (often marks wrong answers)
 */
function analyzeAbsoluteTerms(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const counts = options.map((o) => ({
    label: o.label,
    count: countMatches(o.text, ABSOLUTE_PATTERNS),
  }));

  const withAbsolutes = counts.filter((c) => c.count > 0);
  const withoutAbsolutes = counts.filter((c) => c.count === 0);

  // If exactly one option lacks absolutes while others have them
  if (withoutAbsolutes.length === 1 && withAbsolutes.length >= 2) {
    return {
      score: 0.7,
      issue: `Most options use absolute terms except ${withoutAbsolutes[0].label}`,
      likelyCorrect: withoutAbsolutes[0].label,
    };
  }

  // If one option has many absolutes
  const maxAbsolutes = Math.max(...counts.map((c) => c.count));
  if (maxAbsolutes >= 2) {
    const withMost = counts.find((c) => c.count === maxAbsolutes);
    return {
      score: 0.4,
      issue: `Option ${withMost?.label} uses multiple absolute terms`,
      likelyCorrect: null, // Can't determine correct, just flag the bad distractor
    };
  }

  return { score: 0, issue: null, likelyCorrect: null };
}

/**
 * Analyze parenthetical explanations
 */
function analyzeParentheticals(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const counts = options.map((o) => ({
    label: o.label,
    count: (o.text.match(PARENTHETICAL_PATTERN) || []).length,
  }));

  const withParens = counts.filter((c) => c.count > 0);
  const withoutParens = counts.filter((c) => c.count === 0);

  // If exactly one option has parentheticals
  if (withParens.length === 1 && withoutParens.length >= 2) {
    return {
      score: 0.7,
      issue: `Only option ${withParens[0].label} has parenthetical explanation`,
      likelyCorrect: withParens[0].label,
    };
  }

  return { score: 0, issue: null, likelyCorrect: null };
}

/**
 * Analyze specificity asymmetry (specific numbers, doses, timeframes)
 */
function analyzeSpecificity(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const counts = options.map((o) => ({
    label: o.label,
    count: countMatches(o.text, SPECIFICITY_PATTERNS),
  }));

  const maxSpec = Math.max(...counts.map((c) => c.count));
  const minSpec = Math.min(...counts.map((c) => c.count));

  if (maxSpec === 0) return { score: 0, issue: null, likelyCorrect: null };

  // One option is much more specific
  const mostSpecific = counts.filter((c) => c.count === maxSpec);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _leastSpecific = counts.filter((c) => c.count === minSpec);

  if (mostSpecific.length === 1 && maxSpec >= 2 && minSpec === 0) {
    return {
      score: 0.6,
      issue: `Option ${mostSpecific[0].label} is much more specific than others`,
      likelyCorrect: mostSpecific[0].label,
    };
  }

  return { score: 0, issue: null, likelyCorrect: null };
}

/**
 * Analyze linguistic sophistication (medical terminology density)
 */
function analyzeSophistication(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const densities = options.map((o) => {
    const termCount = countMatches(o.text, MEDICAL_TERM_PATTERNS);
    const wordCount = o.text.split(/\s+/).length;
    return {
      label: o.label,
      density: wordCount > 0 ? termCount / wordCount : 0,
    };
  });

  const maxDensity = Math.max(...densities.map((d) => d.density));
  const minDensity = Math.min(...densities.map((d) => d.density));

  if (maxDensity - minDensity < 0.1) return { score: 0, issue: null, likelyCorrect: null };

  const mostSophisticated = densities.find((d) => d.density === maxDensity);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _leastSophisticated = densities.find((d) => d.density === minDensity);

  // Large gap in terminology density
  if (maxDensity > minDensity * 2 && maxDensity > 0.2) {
    return {
      score: 0.5,
      issue: `Option ${mostSophisticated?.label} uses more medical terminology`,
      likelyCorrect: mostSophisticated?.label || null,
    };
  }

  return { score: 0, issue: null, likelyCorrect: null };
}

/**
 * Analyze all guessability signals for a question's options
 */
export function analyzeGuessability(options: Option[]): GuessabilityProfile {
  if (options.length < 2) {
    return {
      score: 0,
      signals: {
        lengthAsymmetry: 0,
        qualifierAsymmetry: 0,
        absoluteTermTrap: 0,
        specificityAsymmetry: 0,
        parentheticalTell: 0,
        sophisticationAsymmetry: 0,
      },
      issues: [],
      likelyCorrectByTell: null,
    };
  }

  const length = analyzeLengthAsymmetry(options);
  const qualifier = analyzeQualifierAsymmetry(options);
  const absolute = analyzeAbsoluteTerms(options);
  const parenthetical = analyzeParentheticals(options);
  const specificity = analyzeSpecificity(options);
  const sophistication = analyzeSophistication(options);

  // Collect issues
  const issues: string[] = [];
  if (length.issue) issues.push(length.issue);
  if (qualifier.issue) issues.push(qualifier.issue);
  if (absolute.issue) issues.push(absolute.issue);
  if (parenthetical.issue) issues.push(parenthetical.issue);
  if (specificity.issue) issues.push(specificity.issue);
  if (sophistication.issue) issues.push(sophistication.issue);

  // Determine likely correct by tells (consensus)
  const candidates = [
    length.likelyCorrect,
    qualifier.likelyCorrect,
    absolute.likelyCorrect,
    parenthetical.likelyCorrect,
    specificity.likelyCorrect,
    sophistication.likelyCorrect,
  ].filter(Boolean) as string[];

  // Find most common candidate
  const candidateCounts: Record<string, number> = {};
  for (const c of candidates) {
    candidateCounts[c] = (candidateCounts[c] || 0) + 1;
  }
  const sorted = Object.entries(candidateCounts).sort((a, b) => b[1] - a[1]);
  const likelyCorrectByTell = sorted.length > 0 && sorted[0][1] >= 2 ? sorted[0][0] : null;

  // Calculate aggregate score (weighted)
  const score =
    length.score * 0.25 +
    qualifier.score * 0.2 +
    absolute.score * 0.15 +
    parenthetical.score * 0.15 +
    specificity.score * 0.15 +
    sophistication.score * 0.1;

  return {
    score: Math.min(1, score),
    signals: {
      lengthAsymmetry: length.score,
      qualifierAsymmetry: qualifier.score,
      absoluteTermTrap: absolute.score,
      specificityAsymmetry: specificity.score,
      parentheticalTell: parenthetical.score,
      sophisticationAsymmetry: sophistication.score,
    },
    issues,
    likelyCorrectByTell,
  };
}

/**
 * Check if a question's tells correctly identify the actual correct answer
 * This is the key metric: if tells predict correct, question is exploitable
 */
export function validateAgainstCorrect(
  options: Option[],
  profile: GuessabilityProfile
): {
  tellsMatchCorrect: boolean;
  actualCorrectLabel: string | null;
  confidence: number;
} {
  const correctOption = options.find((o) => o.isCorrect);
  const actualCorrectLabel = correctOption?.label || null;

  if (!actualCorrectLabel || !profile.likelyCorrectByTell) {
    return { tellsMatchCorrect: false, actualCorrectLabel, confidence: 0 };
  }

  const tellsMatchCorrect = profile.likelyCorrectByTell === actualCorrectLabel;

  return {
    tellsMatchCorrect,
    actualCorrectLabel,
    confidence: profile.score,
  };
}

/**
 * Get severity level for reporting
 */
export function getGuessabilitySeverity(
  score: number
): 'none' | 'low' | 'medium' | 'high' | 'critical' {
  if (score < 0.1) return 'none';
  if (score < 0.25) return 'low';
  if (score < 0.45) return 'medium';
  if (score < 0.65) return 'high';
  return 'critical';
}
