/**
 * Math rendering utilities for flashcard content.
 * Uses KaTeX for rendering LaTeX math expressions.
 *
 * Usage:
 *   Inline math: $x$ or \(x\)
 *   Display math: $$x$$ or \[x\]
 *
 * Common medical symbols:
 *   $\geq$ → ≥
 *   $\leq$ → ≤
 *   $\rightarrow$ → →
 *   $O_2$ → O₂
 *   $CO_2$ → CO₂
 */

import { renderToString as katexRender } from 'katex';

/**
 * Render LaTeX math in a string to HTML.
 * Handles both inline ($...$) and display ($$...$$) math.
 */
export function renderMath(text: string): string {
  if (!text) return text;

  let result = '';
  let cursor = 0;

  while (cursor < text.length) {
    const dollarIndex = text.indexOf('$', cursor);
    if (dollarIndex === -1) {
      result += escapeHtml(text.slice(cursor));
      break;
    }

    // Append plain text before the math delimiter.
    result += escapeHtml(text.slice(cursor, dollarIndex));

    // Display math: $$...$$
    if (text[dollarIndex + 1] === '$') {
      const endIndex = text.indexOf('$$', dollarIndex + 2);
      if (endIndex === -1) {
        // Unmatched delimiter - render as escaped plain text.
        result += escapeHtml(text.slice(dollarIndex));
        break;
      }

      const math = text.slice(dollarIndex + 2, endIndex).trim();
      result += renderMathExpression(math, true, `$$${math}$$`);
      cursor = endIndex + 2;
      continue;
    }

    // Inline math: $...$
    const endIndex = text.indexOf('$', dollarIndex + 1);
    if (endIndex === -1) {
      result += escapeHtml(text.slice(dollarIndex));
      break;
    }

    const math = text.slice(dollarIndex + 1, endIndex).trim();
    result += renderMathExpression(math, false, `$${math}$`);
    cursor = endIndex + 1;
  }

  return result;
}

/**
 * Check if a string contains LaTeX math expressions or medical shortcut tokens.
 *
 * Re-exported from the KaTeX-free `contains-math` module so that eager callers
 * (the review render path) can detect math without pulling KaTeX into the
 * initial bundle. Import it from '@/lib/math/contains-math' directly on any
 * critical path — importing it from here drags in KaTeX via this module.
 */
export { containsMath } from './contains-math';

/**
 * Common medical symbol shortcuts.
 * Can be applied before renderMath to auto-convert ASCII to LaTeX.
 */
export const medicalShortcuts: Record<string, string> = {
  // Comparison operators (only convert when not already in math mode)
  '>=': '$\\geq$',
  '<=': '$\\leq$',

  // Chemical formulas and clinical abbreviations.
  //
  // These are PROSE, not equations. Rendering `SpO2` as `$SpO_2$` makes KaTeX
  // treat the letters as multiplied variables and sets them in serif italics,
  // which is the conspicuous wart on otherwise sans-serif review cards that a
  // user flagged ("what's with the weird custom italicized font for spo2?").
  // SpO2 was fixed first; every sibling here had the identical defect, so the
  // whole class now uses Unicode sub/superscripts, which preserve the notation
  // without switching typeface. Genuine maths written as `$...$` in the source
  // is untouched.
  'O2': 'O₂',
  'CO2': 'CO₂',
  'HCO3-': 'HCO₃⁻',
  'PaO2': 'PaO₂',
  'PaCO2': 'PaCO₂',
  'FiO2': 'FiO₂',
  'SpO2': 'SpO₂',
  'SaO2': 'SaO₂',
  'EtCO2': 'EtCO₂',
  'H2O': 'H₂O',
  'Ca2+': 'Ca²⁺',
  'K+': 'K⁺',
  'Na+': 'Na⁺',
  'Mg2+': 'Mg²⁺',

  // Greek letters
  'Delta': '$\\Delta$',
  'alpha': '$\\alpha$',
  'beta': '$\\beta$',

  // Arrows
  '->': '$\\rightarrow$',
  '<-': '$\\leftarrow$',
};

/**
 * Apply medical shortcuts to convert ASCII to LaTeX.
 * Use sparingly - explicit LaTeX is clearer.
 */
export function applyMedicalShortcuts(text: string): string {
  if (!text) return text;

  let result = text;

  // Sort by length (longest first) to avoid partial replacements
  const sortedShortcuts = Object.entries(medicalShortcuts)
    .sort(([a], [b]) => b.length - a.length);

  for (const [shortcut, latex] of sortedShortcuts) {
    // Only replace if not already inside math delimiters
    // This is a simple heuristic - may need refinement
    const regex = new RegExp(`(?<!\\$[^$]*)${escapeRegex(shortcut)}(?![^$]*\\$)`, 'g');
    result = result.replace(regex, latex);
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMathExpression(math: string, displayMode: boolean, fallback: string): string {
  try {
    return katexRender(math, {
      throwOnError: false,
      displayMode,
    });
  } catch {
    return escapeHtml(fallback);
  }
}

/**
 * Render math with optional shortcut preprocessing.
 * This is the main function to use for card content.
 */
export function renderCardMath(text: string, useShortcuts = false): string {
  if (!text) return text;

  let processed = text;
  if (useShortcuts) {
    processed = applyMedicalShortcuts(processed);
  }

  return renderMath(processed);
}
