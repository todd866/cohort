/**
 * Citation view types for the card detail page.
 *
 * Historically this file also owned an EVIDENCE_TIERS taxonomy (Guidelines /
 * Research / Foundational) that the page grouped by. It was removed: the tier
 * came from SourceCitation.stabilityTier, which the grounded pipeline set to
 * 'research' for anything that was not explicitly a guideline — and 2,854 of
 * 2,898 grounded entries carry tier "unknown". The result was textbooks filed
 * under "RCTs, meta-analyses, landmark trials". Source kind is now shown per
 * citation, only where it is actually known.
 */

import type { EvidenceLinkView } from './evidence-presentation';

/**
 * A CardCitation or QuestionCitation joined to its SourceCitation and Source.
 *
 * The two link tables are field-for-field identical apart from their owning id,
 * and neither id is read here, so one view type serves both detail pages.
 */
export type CitationLinkWithSource = {
  id: string;
  isPrimary: boolean;
  relationship: string;
  jurisdictionNote: string | null;
  verifiedAt: Date | null;
  // Grounded-audit provenance (null for authoring/curation/user links).
  groundingState: string | null;
  judgedAt: Date | null;
  judgedBy: string | null;
  corpusVersion: string | null;
  sourceTrust: string | null;
  matchCoverage: number | null;
  citation: {
    id: string;
    level1Text: string;
    level2Quote: string | null;
    page: string | null;
    section: string | null;
    stabilityTier: string;
    verified: boolean;
    verifiedAt: Date | null;
    source: {
      jurisdiction: string | null;
      name: string;
      shortName: string;
      sourceType: string;
      url: string | null;
    };
  };
};

/** Historical name, kept so existing imports keep working. */
export type CardCitationWithSource = CitationLinkWithSource;

/** Flatten a loaded citation into the shape the presentation helpers judge. */
export function toEvidenceLinkView(cc: CitationLinkWithSource): EvidenceLinkView {
  return {
    relationship: cc.relationship,
    isPrimary: cc.isPrimary,
    groundingState: cc.groundingState,
    judgedAt: cc.judgedAt,
    judgedBy: cc.judgedBy,
    corpusVersion: cc.corpusVersion,
    sourceTrust: cc.sourceTrust,
    matchCoverage: cc.matchCoverage,
    quote: cc.citation.level2Quote,
    humanVerified: cc.citation.verified,
    humanVerifiedAt: cc.citation.verifiedAt ?? cc.verifiedAt,
  };
}
