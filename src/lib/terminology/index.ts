/**
 * Medical Terminology Normalization
 *
 * Implements Principle #2 from embedding-design-principles.md:
 * "Store concepts in canonical full-text form. Map abbreviations and synonyms at query/display time."
 *
 * Benefits:
 * - Embeddings are unambiguous (no "MI" vs "myocardial infarction" distance issues)
 * - Users can search either way
 * - Display adapts to user preferences
 */

import { prisma } from '@/lib/prisma';
import type { MedicalTerm } from '@prisma/client';

// In-memory cache for fast lookups (refreshed periodically)
let termCache: Map<string, MedicalTerm> | null = null;
let aliasToCanonical: Map<string, string> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load terms into memory for fast access
 */
async function ensureCache(): Promise<void> {
  const now = Date.now();
  if (termCache && now - cacheTimestamp < CACHE_TTL_MS) {
    return;
  }

  const terms = await prisma.medicalTerm.findMany();

  termCache = new Map();
  aliasToCanonical = new Map();

  for (const term of terms) {
    // Index by canonical form
    termCache.set(term.canonical.toLowerCase(), term);

    // Index all aliases pointing to canonical
    for (const alias of term.aliases) {
      aliasToCanonical.set(alias.toLowerCase(), term.canonical);
    }

    // Also index canonical as an alias to itself
    aliasToCanonical.set(term.canonical.toLowerCase(), term.canonical);
  }

  cacheTimestamp = now;
}

/**
 * Expand a search query by adding canonical forms and aliases
 *
 * Example: "MI symptoms" → "myocardial infarction MI heart attack symptoms"
 */
export async function expandQuery(query: string): Promise<string> {
  await ensureCache();
  if (!aliasToCanonical || !termCache) return query;

  const words = query.split(/\s+/);
  const expandedTerms = new Set<string>();

  for (const word of words) {
    expandedTerms.add(word);

    const canonical = aliasToCanonical.get(word.toLowerCase());
    if (canonical) {
      // Add canonical form
      expandedTerms.add(canonical);

      // Add all aliases
      const term = termCache.get(canonical.toLowerCase());
      if (term) {
        for (const alias of term.aliases) {
          expandedTerms.add(alias);
        }
      }
    }
  }

  return Array.from(expandedTerms).join(' ');
}

/**
 * Convert text to user's preferred display format
 *
 * @param text - Text with canonical terms
 * @param preferAbbreviations - User's preference
 * @returns Text with terms converted to preferred format
 */
export async function formatForDisplay(
  text: string,
  preferAbbreviations: boolean
): Promise<string> {
  if (!preferAbbreviations) {
    // Canonical form is already stored, no conversion needed
    return text;
  }

  await ensureCache();
  if (!termCache) return text;

  let result = text;

  // Replace canonical forms with preferred abbreviations
  for (const [, term] of termCache) {
    if (term.preferredAbbreviation) {
      // Case-insensitive replacement while preserving sentence case
      const regex = new RegExp(`\\b${escapeRegex(term.canonical)}\\b`, 'gi');
      result = result.replace(regex, term.preferredAbbreviation);
    }
  }

  return result;
}

/**
 * Get the canonical form of a term (or return original if not found)
 */
export async function toCanonical(term: string): Promise<string> {
  await ensureCache();
  if (!aliasToCanonical) return term;

  return aliasToCanonical.get(term.toLowerCase()) || term;
}

/**
 * Check if a term is ambiguous (has multiple meanings)
 */
export async function isAmbiguous(term: string): Promise<boolean> {
  await ensureCache();
  if (!aliasToCanonical || !termCache) return false;

  const canonical = aliasToCanonical.get(term.toLowerCase());
  if (!canonical) return false;

  const termData = termCache.get(canonical.toLowerCase());
  return termData?.ambiguous ?? false;
}

/**
 * Get definition for a term (for tooltips)
 */
export async function getDefinition(term: string): Promise<string | null> {
  await ensureCache();
  if (!aliasToCanonical || !termCache) return null;

  const canonical = aliasToCanonical.get(term.toLowerCase());
  if (!canonical) return null;

  const termData = termCache.get(canonical.toLowerCase());
  return termData?.definition ?? null;
}


// Helper to escape special regex characters
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Re-export types
export type { MedicalTerm };
