/**
 * Citation Normalization
 *
 * Parses raw citation strings and normalizes them to structured Source references.
 * Handles various formats like "CC Bible p.131", "eTG Anaphylaxis", etc.
 */

import { prisma } from '@/lib/prisma';

export interface ParsedCitation {
  sourceSlug: string | null;
  page: string | null;
  section: string | null;
  rawText: string;
}

/**
 * Parse a raw citation string into structured components
 */
export async function parseCitation(raw: string): Promise<ParsedCitation> {
  const normalized = raw.toLowerCase().trim();

  // Get all sources with their aliases
  const sources = await prisma.source.findMany({
    select: { slug: true, aliases: true },
  });

  // Find matching source by alias
  let matchedSlug: string | null = null;
  let matchedAliasLength = 0;

  for (const source of sources) {
    for (const alias of source.aliases) {
      const aliasLower = alias.toLowerCase();
      if (normalized.includes(aliasLower) && aliasLower.length > matchedAliasLength) {
        matchedSlug = source.slug;
        matchedAliasLength = aliasLower.length;
      }
    }
  }

  // Extract page reference
  // Matches: "p.131", "p. 131", "p131", "pp. 131-136", "page 12", "Ch.12", "Chapter 12"
  const pagePatterns = [
    /p\.?\s*(\d+(?:\s*-\s*\d+)?)/i, // p.131, p. 131-136
    /pp\.?\s*(\d+(?:\s*-\s*\d+)?)/i, // pp.131-136
    /page\s*(\d+(?:\s*-\s*\d+)?)/i, // page 12
    /ch\.?\s*(\d+)/i, // Ch.12
    /chapter\s*(\d+)/i, // Chapter 12
  ];

  let page: string | null = null;
  for (const pattern of pagePatterns) {
    const match = raw.match(pattern);
    if (match) {
      page = match[1].replace(/\s+/g, '');
      break;
    }
  }

  // Extract section (text after common separators)
  // e.g., "eTG - Anaphylaxis" → section: "Anaphylaxis"
  let section: string | null = null;
  const sectionPatterns = [
    /[-–—]\s*(.+?)(?:\s*p\.|\s*$)/i, // "eTG - Anaphylaxis"
    /:\s*(.+?)(?:\s*p\.|\s*$)/i, // "eTG: Anaphylaxis"
  ];

  for (const pattern of sectionPatterns) {
    const match = raw.match(pattern);
    if (match && match[1].trim().length > 0) {
      section = match[1].trim();
      break;
    }
  }

  return {
    sourceSlug: matchedSlug,
    page,
    section,
    rawText: raw,
  };
}

/**
 * Parse citation and return with source details
 */
export async function parseCitationWithSource(raw: string) {
  const parsed = await parseCitation(raw);

  if (!parsed.sourceSlug) {
    return { ...parsed, source: null };
  }

  const source = await prisma.source.findUnique({
    where: { slug: parsed.sourceSlug },
    select: {
      id: true,
      slug: true,
      name: true,
      shortName: true,
      reliability: true,
      sourceType: true,
    },
  });

  return { ...parsed, source };
}

/**
 * Create or find a SourceCitation from a raw citation string
 */
export async function getOrCreateSourceCitation(raw: string) {
  const parsed = await parseCitationWithSource(raw);

  if (!parsed.source) {
    // Unknown source - return null or create as unverified
    return null;
  }

  // Build level1Text (the visible badge text)
  let level1Text = parsed.source.shortName;
  if (parsed.page) {
    level1Text += ` p.${parsed.page}`;
  }
  if (parsed.section) {
    level1Text += ` - ${parsed.section}`;
  }

  // Check if this citation already exists
  const existing = await prisma.sourceCitation.findFirst({
    where: {
      sourceId: parsed.source.id,
      page: parsed.page,
      section: parsed.section,
    },
  });

  if (existing) {
    return existing;
  }

  // Create new citation
  return prisma.sourceCitation.create({
    data: {
      sourceId: parsed.source.id,
      page: parsed.page,
      section: parsed.section,
      level1Text,
    },
  });
}

/**
 * Bulk migrate existing citations[] to SourceCitation relations
 */
export async function migrateLegacyCitations() {
  // Get all facts with legacy citations
  const facts = await prisma.fact.findMany({
    where: {
      citations: { isEmpty: false },
    },
    select: { id: true, citations: true },
  });

  let migrated = 0;
  let skipped = 0;

  for (const fact of facts) {
    for (const rawCitation of fact.citations) {
      const sourceCitation = await getOrCreateSourceCitation(rawCitation);

      if (sourceCitation) {
        // Link to fact (using raw SQL since Prisma doesn't handle implicit m2m well)
        try {
          await prisma.$executeRaw`
            INSERT INTO "_FactToSourceCitation" ("A", "B")
            VALUES (${fact.id}, ${sourceCitation.id})
            ON CONFLICT DO NOTHING
          `;
          migrated++;
        } catch {
          // Already linked or other error
          skipped++;
        }
      } else {
        skipped++;
      }
    }
  }

  return { migrated, skipped };
}
