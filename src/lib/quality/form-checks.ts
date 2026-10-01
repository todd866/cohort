import type { CheckStatus } from './types';

interface FormCheckResult {
  status: CheckStatus;
  issues: string[];
}

interface OptionInput {
  text: string;
  isCorrect: boolean;
}

const FILLER_PATTERNS = [
  /does not align with/i,
  /is not indicated for/i,
  /does not address the/i,
  /is not appropriate in this/i,
  /does not reflect current/i,
  /is not consistent with/i,
  /is not supported by/i,
];

const ABSOLUTE_TERMS = ['always', 'never', 'all', 'none', 'every', 'no patient'];

export function checkFormOpacity(options: OptionInput[]): FormCheckResult {
  if (options.length === 0) return { status: 'na', issues: [] };

  const issues: string[] = [];

  // Length variance check
  const lengths = options.map(o => o.text.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const maxDeviation = Math.max(...lengths.map(l => Math.abs(l - avgLength) / avgLength));

  if (maxDeviation > 0.5) {
    const shortest = Math.min(...lengths);
    const longest = Math.max(...lengths);
    issues.push(`length_variance: shortest ${shortest} chars, longest ${longest} chars (${Math.round(maxDeviation * 100)}% deviation)`);
  }

  // Correct answer significantly longer than distractors
  const correct = options.find(o => o.isCorrect);
  const distractors = options.filter(o => !o.isCorrect);
  if (correct && distractors.length > 0) {
    const avgDistractorLen = distractors.reduce((a, o) => a + o.text.length, 0) / distractors.length;
    if (correct.text.length > avgDistractorLen * 1.5) {
      issues.push(`correct_answer_longer: correct is ${correct.text.length} chars, avg distractor is ${Math.round(avgDistractorLen)} chars`);
    }
  }

  // Filler text detection
  for (const opt of options) {
    for (const pattern of FILLER_PATTERNS) {
      if (pattern.test(opt.text)) {
        issues.push(`filler_text: "${opt.text.substring(0, 50)}..."`);
        break;
      }
    }
  }

  // Absolute terms — only flag when the CORRECT answer uses an absolute term.
  // Distractors using "always/never/all" is standard MCQ design (clearly wrong options).
  // The real giveaway is a correct answer with absolutes (students eliminate those first).
  // Strip uppercase medical acronyms in parentheses, e.g. "(ALL)" for acute lymphoblastic leukaemia
  if (correct) {
    const strippedCorrect = correct.text.replace(/\([A-Z]{2,}\)/g, '');
    const correctAbsolute = ABSOLUTE_TERMS.find(t => new RegExp(`\\b${t}\\b`, 'i').test(strippedCorrect));
    if (correctAbsolute) {
      issues.push(`absolute_terms: "${correctAbsolute}" in correct answer "${correct.text.substring(0, 40)}"`);
    }
  }

  return {
    status: issues.length > 0 ? 'fail' : 'pass',
    issues,
  };
}
