/**
 * Citation Harvester
 *
 * Fetches, stores, and versions citation content for audit trail.
 * Safety-critical: All content is immutably stored and never deleted.
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

export interface HarvestResult {
  snapshotId: string;
  citationId: string;
  contentHash: string;
  contentChanged: boolean;
  isNewCitation: boolean;
}

export interface HarvestOptions {
  sourceSlug: string;       // e.g., 'nsw-aci-ecat'
  sourceName: string;       // e.g., 'NSW ACI ECAT Chest Pain'
  sourceType?: string;      // 'guidelines', 'textbook', etc.
  reliability?: number;     // 1-5
  url: string;
  section?: string;         // e.g., 'Opioid Analgesia'
  extractQuote?: string;    // Specific text to highlight
  actor?: string;           // Who initiated this harvest
}

/**
 * Compute SHA-256 hash of content
 */
function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Extract clean text from HTML
 * Simple extraction - strips tags, normalizes whitespace
 */
function extractText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract page title from HTML
 */
function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}

/**
 * Fetch URL content with metadata
 */
async function fetchUrl(url: string): Promise<{
  content: string;
  contentType: string | null;
  httpStatus: number;
  lastModified: Date | null;
}> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'MD3-Citation-Harvester/1.0 (Medical Education Safety Tool)',
    },
  });

  const content = await response.text();
  const contentType = response.headers.get('content-type');
  const lastModifiedHeader = response.headers.get('last-modified');
  const lastModified = lastModifiedHeader ? new Date(lastModifiedHeader) : null;

  return {
    content,
    contentType,
    httpStatus: response.status,
    lastModified,
  };
}

/**
 * Harvest a citation URL and store versioned snapshot
 *
 * This is the main entry point for capturing citation content.
 * Creates immutable snapshots for audit trail.
 */
export async function harvestCitation(options: HarvestOptions): Promise<HarvestResult> {
  const {
    sourceSlug,
    sourceName,
    sourceType = 'guidelines',
    reliability = 3,
    url,
    section,
    extractQuote,
    actor = 'system',
  } = options;

  // 1. Ensure Source exists
  let source = await prisma.source.findUnique({
    where: { slug: sourceSlug },
  });

  if (!source) {
    source = await prisma.source.create({
      data: {
        slug: sourceSlug,
        name: sourceName,
        shortName: sourceName.length > 20 ? sourceName.substring(0, 20) + '...' : sourceName,
        sourceType,
        reliability,
        url,
      },
    });
  }

  // 2. Find or create SourceCitation
  let citation = await prisma.sourceCitation.findFirst({
    where: {
      sourceId: source.id,
      section: section ?? null,
    },
    include: {
      snapshots: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  const isNewCitation = !citation;

  if (!citation) {
    citation = await prisma.sourceCitation.create({
      data: {
        sourceId: source.id,
        section,
        level1Text: `${source.shortName}${section ? ` - ${section}` : ''}`,
        level2Quote: extractQuote,
      },
      include: {
        snapshots: true,
      },
    });
  }

  // 3. Fetch current content
  const fetched = await fetchUrl(url);
  const contentHash = computeHash(fetched.content);
  const extractedText = extractText(fetched.content);
  const pageTitle = extractTitle(fetched.content);

  // 4. Check if content changed from last snapshot
  const lastSnapshot = citation.snapshots[0];
  const contentChanged = !lastSnapshot || lastSnapshot.contentHash !== contentHash;

  // 5. Create new snapshot (always create for audit trail, even if unchanged)
  const snapshot = await prisma.citationSnapshot.create({
    data: {
      citationId: citation.id,
      url,
      urlAccessedAt: new Date(),
      contentRaw: fetched.content,
      contentHash,
      contentType: fetched.contentType,
      extractedText,
      extractedQuote: extractQuote,
      pageTitle,
      lastModified: fetched.lastModified,
      httpStatus: fetched.httpStatus,
      createdBy: actor,
    },
  });

  // 6. Update citation to point to current snapshot
  await prisma.sourceCitation.update({
    where: { id: citation.id },
    data: {
      currentSnapshotId: snapshot.id,
      level2Quote: extractQuote ?? citation.level2Quote,
    },
  });

  // 7. Log the access
  await prisma.citationAuditLog.create({
    data: {
      snapshotId: snapshot.id,
      action: isNewCitation ? 'created' : contentChanged ? 'content_changed' : 'accessed',
      actor,
      reason: isNewCitation
        ? 'Initial citation harvest'
        : contentChanged
          ? 'Content changed since last snapshot'
          : 'Routine access check',
      previousHash: lastSnapshot?.contentHash,
      newHash: contentHash,
      previousUrl: lastSnapshot?.url,
      newUrl: url !== lastSnapshot?.url ? url : undefined,
    },
  });

  return {
    snapshotId: snapshot.id,
    citationId: citation.id,
    contentHash,
    contentChanged,
    isNewCitation,
  };
}

/**
 * Check if a citation URL is still accessible and unchanged
 */
export async function checkCitation(citationId: string): Promise<{
  isAccessible: boolean;
  contentChanged: boolean;
  urlChanged: boolean;
  newSnapshotId?: string;
}> {
  const citation = await prisma.sourceCitation.findUnique({
    where: { id: citationId },
    include: {
      snapshots: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      source: true,
    },
  });

  if (!citation || !citation.snapshots[0]) {
    return { isAccessible: false, contentChanged: false, urlChanged: false };
  }

  const lastSnapshot = citation.snapshots[0];
  const url = lastSnapshot.url;

  if (!url) {
    return { isAccessible: false, contentChanged: false, urlChanged: false };
  }

  try {
    const fetched = await fetchUrl(url);
    const contentHash = computeHash(fetched.content);
    const contentChanged = contentHash !== lastSnapshot.contentHash;

    // Record the check
    await prisma.citationCheck.create({
      data: {
        snapshotId: lastSnapshot.id,
        httpStatus: fetched.httpStatus,
        contentHash,
        contentChanged,
        isAccessible: fetched.httpStatus === 200,
      },
    });

    // If content changed, create new snapshot
    let newSnapshotId: string | undefined;
    if (contentChanged) {
      const result = await harvestCitation({
        sourceSlug: citation.source.slug,
        sourceName: citation.source.name,
        url,
        section: citation.section ?? undefined,
        actor: 'system_check',
      });
      newSnapshotId = result.snapshotId;
    }

    return {
      isAccessible: fetched.httpStatus === 200,
      contentChanged,
      urlChanged: false,
      newSnapshotId,
    };
  } catch (error) {
    // Network error - log as inaccessible
    await prisma.citationCheck.create({
      data: {
        snapshotId: lastSnapshot.id,
        isAccessible: false,
        contentChanged: false,
      },
    });

    await prisma.citationAuditLog.create({
      data: {
        snapshotId: lastSnapshot.id,
        action: 'broken_link',
        actor: 'system_check',
        reason: `Failed to access URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
    });

    return { isAccessible: false, contentChanged: false, urlChanged: false };
  }
}

/**
 * Get citation with full audit history
 */
export async function getCitationHistory(citationId: string) {
  return prisma.sourceCitation.findUnique({
    where: { id: citationId },
    include: {
      source: true,
      snapshots: {
        orderBy: { createdAt: 'desc' },
        include: {
          auditLogs: {
            orderBy: { occurredAt: 'desc' },
          },
        },
      },
    },
  });
}

/**
 * Search for a citation by URL
 */
export async function findCitationByUrl(url: string) {
  const snapshot = await prisma.citationSnapshot.findFirst({
    where: { url },
    orderBy: { createdAt: 'desc' },
    include: {
      citation: {
        include: {
          source: true,
        },
      },
    },
  });

  return snapshot?.citation;
}
