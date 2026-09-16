/**
 * Card Validators - Validation logic for generated cards
 *
 * Validates card quality and catches issues before they enter the database.
 */

import { existsSync } from 'fs';
import * as path from 'path';
import type { GeneratedCard } from './card-generator';
import { detectBadClozeSpans } from './cloze-quality';

/**
 * Extract MCQ option structure from card front/back for guessability analysis.
 * Returns null if the card doesn't contain a parseable MCQ option pattern.
 */
export function extractMCQOptions(
  front: string,
  back: string
): { label: string; text: string; isCorrect: boolean }[] | null {
  // Match option lines like "A) text", "A. text", "A: text"
  const optionRegex = /^([A-E])[).:\s]\s*(.+)$/gm;
  const options: { label: string; text: string; isCorrect: boolean }[] = [];

  let match;
  while ((match = optionRegex.exec(front)) !== null) {
    options.push({
      label: match[1],
      text: match[2].trim(),
      isCorrect: false, // will be set below
    });
  }

  if (options.length < 2) return null;

  // Mark the correct answer by matching back text (case-insensitive)
  const backLower = back.toLowerCase().trim();
  for (const option of options) {
    if (option.text.toLowerCase().trim() === backLower) {
      option.isCorrect = true;
    }
  }

  return options;
}

/**
 * Card quality issues that should be flagged
 */
export interface CardQualityIssue {
  card: GeneratedCard;
  issue: string;
  severity: 'error' | 'warning';
}

/**
 * Validate card quality and return issues
 * Use this to catch obviously bad cards before they enter the database
 */
export function validateCard(card: GeneratedCard): CardQualityIssue[] {
  const issues: CardQualityIssue[] = [];
  const blankCount = (card.front.match(/\[___\]/g) ?? []).length;

  // Answer too short (likely parsing error)
  // Allow 2-3 char answers - they're often valid (abbreviations, percentages, codes)
  // Only flag 1-char answers as errors
  // Skip for multi-cloze cards where back is just the first blank (e.g. "8" for count)
  if (card.back.length <= 1 && !(card.backs && card.backs.length > 1)) {
    issues.push({
      card,
      issue: `Answer too short: "${card.back}" (${card.back.length} chars)`,
      severity: 'error',
    });
  }

  // Answer ends with ? (likely a header was used as answer)
  if (card.back.endsWith('?')) {
    issues.push({
      card,
      issue: `Answer looks like a question: "${card.back}"`,
      severity: 'error',
    });
  }

  // Answer ends with : (likely a header label)
  if (card.back.endsWith(':')) {
    issues.push({
      card,
      issue: `Answer looks like a label: "${card.back}"`,
      severity: 'warning',
    });
  }

  // Front already contains most of the answer (too easy)
  const backWords = card.back.toLowerCase().split(/\s+/);
  const frontLower = card.front.toLowerCase();
  const containedWords = backWords.filter(w => w.length > 3 && frontLower.includes(w));
  if (containedWords.length > backWords.length * 0.5 && backWords.length > 1) {
    issues.push({
      card,
      issue: `Front contains too much of the answer: "${containedWords.join(', ')}"`,
      severity: 'warning',
    });
  }

  // Empty or placeholder content (only for cloze cards — MCQs don't have blanks)
  if (card.cardType === 'cloze' && card.front.includes('[___]') === false) {
    issues.push({
      card,
      issue: 'Front has no cloze blank [___]',
      severity: 'error',
    });
  }

  // Overlong fronts are hard to review quickly and usually indicate card scope drift.
  const frontWordCount = card.front.split(/\s+/).filter(Boolean).length;
  if (frontWordCount > 45) {
    issues.push({
      card,
      issue: `Front unusually long: ${frontWordCount} words (target <= 45)`,
      severity: 'warning',
    });
  }

  // Very long answers (might be a parsing error)
  if (card.back.length > 100 && !(card.backs && card.backs.length > 1)) {
    issues.push({
      card,
      issue: `Answer unusually long: ${card.back.length} chars`,
      severity: 'warning',
    });
  }

  // Leading [___] — no question framing before the blank (cloze only)
  if (card.cardType === 'cloze') {
    const frontStripped = card.front
      .replace(/^(⚠️\s*DANGER:\s*|💡\s*PEARL:\s*|🔑\s*)/u, '')
      .trimStart();
    if (frontStripped.startsWith('[___]')) {
      issues.push({
        card,
        issue: 'Front starts with [___] — no question framing before the blank',
        severity: 'warning',
      });
    }
  }

  // Bad cloze span selection: the blank tests a fragment rather than a
  // semantic unit. Examples: "[___]-4 weeks" -> "2" should be "[___] weeks"
  // -> "2-4"; "fragile [___]" -> "X" should test the full condition/gene.
  if (card.cardType === 'cloze') {
    const answers = card.backs && card.backs.length > 0 ? card.backs : [card.back];
    const badSpans = detectBadClozeSpans(card.front, answers);
    if (badSpans.length > 0) {
      const sample = badSpans
        .slice(0, 3)
        .map((span) => `blank ${span.blankIndex + 1} "${span.answer}" (${span.kind})`)
        .join(', ');
      issues.push({
        card,
        issue: `Bad cloze span selection: ${sample}`,
        severity: 'warning',
      });
    }
  }

  // Image references without actual images
  if (/\b(look at the|shown in the|see the|in this) (image|figure|ecg|tracing|x-ray|ct|scan)\b/i.test(card.front) && !card.imageUrl) {
    issues.push({
      card,
      issue: 'Front references an image but card has no imageUrl',
      severity: 'error',
    });
  }

  // imageUrl is "available" when either the local file exists in public/
  // (hand-curated images) or a sidecar exists in figure-sidecars/ (R2-hosted
  // images served via signed URLs). Missing in both → warn.
  if (card.imageUrl && card.imageUrl.startsWith('/figures/')) {
    const localPath = path.join(process.cwd(), 'public', card.imageUrl);
    const sidecarPath = path.join(process.cwd(), 'figure-sidecars',
      `${card.imageUrl.slice('/figures/'.length)}.json`);
    if (!existsSync(localPath) && !existsSync(sidecarPath)) {
      issues.push({
        card,
        issue: `imageUrl "${card.imageUrl}" does not exist on disk and has no sidecar`,
        severity: 'warning',
      });
    }
  }

  // Backs array / blank count mismatch
  if (card.cardType === 'cloze' && blankCount > 1 && (!card.backs || card.backs.length === 0)) {
    issues.push({
      card,
      issue: `Multi-blank cloze requires backs array; found ${blankCount} blanks with no backs`,
      severity: 'error',
    });
  }

  if (card.backs && card.backs.length > 0) {
    if (blankCount > 0 && card.backs.length !== blankCount) {
      issues.push({
        card,
        issue: `backs array length (${card.backs.length}) does not match blank count (${blankCount}) — mismatch`,
        severity: 'error',
      });
    }
  }

  // JSX/HTML tags in back text
  if (/<[A-Za-z][^>]*>/.test(card.back)) {
    issues.push({
      card,
      issue: `Back contains HTML/JSX tags: "${card.back.slice(0, 60)}..."`,
      severity: 'warning',
    });
  }

  // "One-of-many" cloze: front uses indefinite article ("a characteristic/common/typical X of Y is [___]")
  // and answer is a single short word — likely any of several valid answers could fill the blank.
  // This pattern produces "what am I thinking of" cards that frustrate users.
  if (card.cardType === 'cloze' || card.sourceComponent === 'MCQ') {
    const oneOfMany = /\ba\s+(?:characteristic|common|typical|classic|frequent|recognised|recognized|possible|potential)\s+(?:symptom|feature|sign|finding|manifestation|complication|cause|side.?effect|presentation|example)\s+/i;
    if (oneOfMany.test(card.front) && card.back.split(/\s+/).length <= 2) {
      issues.push({
        card,
        issue: `"One-of-many" cloze: "${card.front.slice(0, 60)}..." → "${card.back}" (answer is one of several valid options)`,
        severity: 'warning',
      });
    }
  }

  // Missing context — cards without context show bare Q/A with no teaching value
  if (!card.context || card.context.trim().length === 0) {
    issues.push({
      card,
      issue: 'Card has no context — students see bare Q/A with no explanation',
      severity: 'warning',
    });
  }

  // Missing citation
  if (!card.cite) {
    issues.push({
      card,
      issue: 'Card has no cite attribute — source not traceable',
      severity: 'warning',
    });
  }

  return issues;
}

/**
 * Validate all cards and return summary
 */
export function validateAllCards(cards: GeneratedCard[]): {
  valid: GeneratedCard[];
  issues: CardQualityIssue[];
  summary: { errors: number; warnings: number; valid: number };
} {
  const allIssues: CardQualityIssue[] = [];
  const valid: GeneratedCard[] = [];

  for (const card of cards) {
    const cardIssues = validateCard(card);
    const hasError = cardIssues.some((i) => i.severity === 'error');
    if (!hasError) {
      valid.push(card);
    }
    allIssues.push(...cardIssues);
  }

  const errors = allIssues.filter(i => i.severity === 'error').length;
  const warnings = allIssues.filter(i => i.severity === 'warning').length;

  return {
    valid,
    issues: allIssues,
    summary: { errors, warnings, valid: valid.length },
  };
}
