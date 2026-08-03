/**
 * Card Generator - Parses MDX content and extracts cloze-deletion cards
 *
 * This is the main orchestration module. Extraction and validation logic
 * are split into separate files:
 * - card-extractors.ts — MDX component extraction (Mnemonic, KeyPoint, MCQ, etc.)
 * - card-validators.ts — Card quality validation
 *
 * Extraction policy: EXPLICIT Q&A ONLY for KeyPoint/Danger/ClinicalPearl.
 * No auto-blank from bold terms. See card-extractors.ts header for details.
 */

import * as fs from 'fs';
import { logger } from '@/lib/logger';
import * as path from 'path';
import { parseFrontmatter } from './frontmatter';
import { CONTENT_ROTATION_IDS, EXAM_PREP_ROTATION_IDS, resolveModuleRotation } from './rotations';
import { parseCiteReference } from './cite-utils';
import { inferSingleSourceSlugFromSourceLines } from './source-registry';

import {
  extractWeekFromFilename,
  extractHeadings,
  extractMnemonicCards,
  extractKeyPointCards,
  extractDangerCards,
  extractClinicalPearlCards,
  splitListAnswerToMultiCloze,
  resetExtractionStats,
  getExtractionStats,
} from './card-extractors';

// Re-export everything from extractors and validators for backward compatibility
export {
  extractWeekFromFilename,
  extractHeadings,
  extractMnemonicCards,
  extractKeyPointCards,
  extractDangerCards,
  extractClinicalPearlCards,
  stripMdxComponents,
  stripCardPrefixes,
  splitListAnswerToMultiCloze,
} from './card-extractors';
export type { Heading } from './card-extractors';

export {
  extractMCQOptions,
  validateCard,
  validateAllCards,
} from './card-validators';
export type { CardQualityIssue } from './card-validators';

export interface GeneratedCard {
  cardType: 'cloze' | 'mcq';
  rotation: string;
  week: number | null;
  sourceFile?: string; // e.g. 'week1-resuscitation'
  sourceComponent: 'Mnemonic' | 'KeyPoint' | 'MCQ' | 'Danger' | 'ClinicalPearl';
  front: string;
  back: string;
  backs?: string[] | null; // Array of answers for multi-cloze one-by-one cards (null after splitter sets to single-blank)
  context?: string;
  imageUrl?: string;
  /** Caption that names the finding and tells the student where to look.
   *  Required whenever imageUrl is set — the harness floor (see
   *  feedback_image_quality_floor + feedback_pedagogy_harness). Authored on
   *  the source <KeyPoint imageCaption="..."> attribute. */
  imageCaption?: string;
  /** 'prompt' = the image is the card stem (image-as-prompt, copyright-tier
   *  only); null/undefined = optional decoration. Authored via
   *  <KeyPoint imageRole="prompt">. Query/gate flag, not a render input. */
  imageRole?: string | null;
  crosslinks?: {
    primary?: string;
    related?: string[];
    concepts?: string[];
  } | null;
  topics: string[];
  complexity: 1 | 2 | 3; // 1=trivial, 2=moderate, 3=complex
  /** Importance for scheduling priority - 1=normal, 2=important, 3=foundational (must-know) */
  importance?: 1 | 2 | 3;
  /** Jurisdiction for filtering - null=universal, 'nsw'|'wa'|'national' = jurisdiction-specific */
  jurisdiction?: string;
  /** Citation reference - format: source-slug:doc-id:version#section (e.g. arc:guideline-11.2:2024#adrenaline) */
  cite?: string;
  /** Concept ID for linking jurisdiction variants - cards with same conceptId are the same concept */
  conceptId?: string;
  /** Explicit cluster assignment for authored cards. Validated against Cluster.rotations before seed upsert. */
  clusterId?: string;
  /** Pre-assigned stable identifier (set by the cloze splitter for variants). */
  stableId?: string;
  /** Cloze variant group key (= base card stableId for siblings; null for non-variants). */
  variantGroupId?: string | null;
  /** 0..N-1 index of which blank this variant tests. */
  variantIndex?: number | null;
  /** 'cloze-blank' for v1 variants. */
  variantType?: string | null;
}

function extractUniqueComponentCites(content: string): string[] {
  const cites = new Set<string>();
  const citeRegex = /\bcite\s*=\s*(["'])(.+?)\1/g;

  let match: RegExpExecArray | null;
  while ((match = citeRegex.exec(content)) !== null) {
    const cite = match[2].trim();
    if (cite) {
      cites.add(cite);
    }
  }

  return [...cites];
}

function getFileCitationSection(filePath: string, rotation: string, filename: string): string {
  const contentDir = path.join(process.cwd(), 'content');
  const relativeToContent = path.relative(contentDir, filePath).replace(/\\/g, '/');
  if (!relativeToContent.startsWith('..')) {
    return relativeToContent;
  }
  return `${rotation}/${filename}`;
}

function toFileLevelCite(citeOrSourceSlug: string, fileCitationSection: string): string {
  const parsed = parseCiteReference(citeOrSourceSlug);
  if (!parsed) {
    return citeOrSourceSlug.trim();
  }
  return parsed.section ? citeOrSourceSlug.trim() : `${parsed.sourceSlug}#${fileCitationSection}`;
}

function inferDefaultCardCite(
  content: string,
  frontmatterCite: unknown,
  fileCitationSection: string
): string | undefined {
  if (typeof frontmatterCite === 'string' && frontmatterCite.trim().length > 0) {
    return toFileLevelCite(frontmatterCite, fileCitationSection);
  }

  const uniqueComponentCites = extractUniqueComponentCites(content);
  if (uniqueComponentCites.length === 1) {
    return uniqueComponentCites[0];
  }

  const uniqueComponentSourceSlugs = new Set(
    uniqueComponentCites
      .map((cite) => parseCiteReference(cite)?.sourceSlug)
      .filter((sourceSlug): sourceSlug is string => Boolean(sourceSlug))
  );
  if (uniqueComponentSourceSlugs.size === 1) {
    return toFileLevelCite([...uniqueComponentSourceSlugs][0], fileCitationSection);
  }

  const inferredSourceSlug = inferSingleSourceSlugFromSourceLines(content);
  return inferredSourceSlug ? toFileLevelCite(inferredSourceSlug, fileCitationSection) : undefined;
}

/**
 * Parse a single MDX file and extract all cards
 */
export function parseContentFile(
  filePath: string,
  rotation: string
): GeneratedCard[] {
  const rawContent = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = parseFrontmatter(rawContent);
  const filename = path.basename(filePath);
  const sourceFile = path.basename(filePath, path.extname(filePath));
  const week = extractWeekFromFilename(filename);
  const headings = extractHeadings(content);
  const fileCitationSection = getFileCitationSection(filePath, rotation, filename);
  const defaultCite = inferDefaultCardCite(content, data.cite, fileCitationSection);

  const cards: GeneratedCard[] = [];

  // Extract from each component type
  cards.push(...extractMnemonicCards(content, rotation, week, headings));
  cards.push(...extractKeyPointCards(content, rotation, week, headings));
  cards.push(...extractDangerCards(content, rotation, week, headings));
  cards.push(...extractClinicalPearlCards(content, rotation, week, headings));

  // Post-process: auto-split list answers into multi-cloze
  // Enrich cards with reference ranges where appropriate and add sourceFile
  return cards.map((card) => {
    const split = splitListAnswerToMultiCloze(card);
    const processed = split
      ? { ...card, front: split.front, back: split.back, backs: split.backs }
      : card;
    return {
      ...processed,
      sourceFile,
      cite: processed.cite ?? defaultCite,
    };
  });
}

/**
 * Parse all content files for a rotation
 */
export function parseRotationContent(
  contentDir: string,
  rotation: string
): GeneratedCard[] {
  const cards: GeneratedCard[] = [];

  if (!fs.existsSync(contentDir)) {
    logger.warn('Content directory not found', { contentDir });
    return cards;
  }

  const files = fs.readdirSync(contentDir).filter(f => f.endsWith('.mdx'));

  for (const file of files) {
    const filePath = path.join(contentDir, file);
    cards.push(...parseContentFile(filePath, rotation));
  }

  return cards;
}

/**
 * Parse all rotations and return all cards
 */
export function parseAllContent(baseContentDir: string): GeneratedCard[] {
  resetExtractionStats();
  const cards: GeneratedCard[] = [];
  for (const rotation of CONTENT_ROTATION_IDS) {
    const rotationDir = path.join(baseContentDir, rotation);
    cards.push(...parseRotationContent(rotationDir, rotation));
  }

  // USMLE Step content lives at content/usmle/step1/ (nested, not flat like rotations)
  // The main loop tries content/usmle-step1/ (doesn't exist), so handle the real path here.
  const usmleStep1Dir = path.join(baseContentDir, 'usmle', 'step1');
  if (fs.existsSync(usmleStep1Dir)) {
    cards.push(...parseRotationContent(usmleStep1Dir, 'usmle-step1'));
  }

  // Also process deep-dives (assign to critical-care rotation)
  const deepDivesDir = path.join(baseContentDir, 'deep-dives');
  if (fs.existsSync(deepDivesDir)) {
    cards.push(...parseRotationContent(deepDivesDir, 'critical-care'));
  }

  // Anki-imported decks live in <rotation>/anki-imports*/ (auto-generated by
  // scripts/anki-import/ — e.g. anki-imports/, anki-imports-y3g/). Pick up
  // every anki-imports* subdir under the parent rotation so they join the
  // normal seed pipeline.
  for (const rotation of CONTENT_ROTATION_IDS) {
    const rotationDir = path.join(baseContentDir, rotation);
    if (!fs.existsSync(rotationDir)) continue;
    const ankiSubdirs = fs.readdirSync(rotationDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('anki-imports'))
      .map((d) => d.name);
    for (const sub of ankiSubdirs) {
      cards.push(...parseRotationContent(path.join(rotationDir, sub), rotation));
    }
  }

  // Process Year 1/Year 2 KAT exam prep content
  for (const rotation of EXAM_PREP_ROTATION_IDS) {
    const examDir = path.join(baseContentDir, rotation);
    if (fs.existsSync(examDir)) {
      cards.push(...parseRotationContent(examDir, rotation));
    }
  }

  // Process modules/ directory (cross-institution, cross-year content)
  const modulesDir = path.join(baseContentDir, 'modules');
  if (fs.existsSync(modulesDir)) {
    const disciplines = fs.readdirSync(modulesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const discipline of disciplines) {
      const disciplineDir = path.join(modulesDir, discipline);
      const years = fs.readdirSync(disciplineDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const year of years) {
        const yearDir = path.join(disciplineDir, year);
        const rotation = resolveModuleRotation(year, discipline);
        cards.push(...parseRotationContent(yearDir, rotation));
      }
    }
  }

  // Log extraction stats for pipeline transparency
  const stats = getExtractionStats();
  const totalSkipped = stats.keyPointSkipped + stats.dangerSkipped + stats.clinicalPearlSkipped;
  if (totalSkipped > 0) {
    logger.info('Teaching-only components skipped (no Q&A format)', {
      keyPoint: `${stats.keyPointTotal - stats.keyPointSkipped}/${stats.keyPointTotal} generated cards`,
      danger: `${stats.dangerTotal - stats.dangerSkipped}/${stats.dangerTotal} generated cards`,
      clinicalPearl: `${stats.clinicalPearlTotal - stats.clinicalPearlSkipped}/${stats.clinicalPearlTotal} generated cards`,
      totalSkipped,
    });
  }

  // Surface context-quality violations so they're visible at every seed.
  // These are non-fatal here (the systemic audit owns the hard gate), but the
  // raw counts make regressions obvious — a new MDX commit that introduces
  // 50 missing-context cards should be impossible to miss.
  const ctxViolations = stats.clozeMissingContext + stats.clozeStubContext + stats.clozeRestatesAnswer;
  if (ctxViolations > 0) {
    logger.warn('Cloze cards with substandard context (run audit:systemic for details)', {
      missingContext: stats.clozeMissingContext,
      stubContext: stats.clozeStubContext,
      restatesAnswer: stats.clozeRestatesAnswer,
      total: ctxViolations,
    });
  }

  return cards;
}
