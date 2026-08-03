/**
 * Evidence Tiers
 *
 * Constants and utilities for citation evidence hierarchy.
 * Used by the card meta page to group and display citations by tier.
 */

// Citation type from CardCitation join table
export type CardCitationWithSource = {
  id: string;
  isPrimary: boolean;
  relationship: string;
  jurisdictionNote: string | null;
  verifiedAt: Date | null;
  citation: {
    id: string;
    level1Text: string;
    level2Quote: string | null;
    stabilityTier: string;
    verified: boolean;
    verifiedAt: Date | null;
    source: {
      jurisdiction: string | null;
      name: string;
      shortName: string;
    };
  };
};

// Evidence hierarchy labels and styling
export const EVIDENCE_TIERS = {
  procedural: {
    label: 'Guidelines & Protocols',
    description: 'Current clinical practice standards',
    icon: '\u{1F4CB}',
    color: 'amber',
    bgClass: 'bg-amber-500/10 border-amber-500/20',
    textClass: 'text-amber-700 dark:text-amber-300',
  },
  research: {
    label: 'Research Evidence',
    description: 'RCTs, meta-analyses, landmark trials',
    icon: '\u{1F52C}',
    color: 'blue',
    bgClass: 'bg-blue-500/10 border-blue-500/20',
    textClass: 'text-blue-700 dark:text-blue-300',
  },
  foundational: {
    label: 'Foundational Knowledge',
    description: 'Textbooks, physiology, mechanisms',
    icon: '\u{1F4DA}',
    color: 'green',
    bgClass: 'bg-green-500/10 border-green-500/20',
    textClass: 'text-green-700 dark:text-green-300',
  },
} as const;

/** Group citations by stability tier, with primary citations sorted first. */
export function groupCitationsByTier(citations: CardCitationWithSource[]) {
  const groups: Record<string, CardCitationWithSource[]> = {
    procedural: [],
    research: [],
    foundational: [],
  };

  for (const cc of citations) {
    const tier = cc.citation.stabilityTier || 'procedural';
    if (groups[tier]) {
      groups[tier].push(cc);
    } else {
      groups.procedural.push(cc);
    }
  }

  // Sort each group: primary first, then by date
  for (const tier of Object.keys(groups)) {
    groups[tier].sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return 0;
    });
  }

  return groups;
}
