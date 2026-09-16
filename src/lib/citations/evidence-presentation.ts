/**
 * evidence-presentation.ts — turn a citation link into something a student can
 * judge, without asserting more than we actually know.
 *
 * The card page previously showed a computed "Strong / Moderate / Basic" grade
 * (tiers present x2, +1 for a primary, +1 for any human verification) and a
 * "✓ Verified / ○ Unverified" chip driven by SourceCitation.verified. Measured
 * 2026-08-25, only 13 of 3,568 SourceCitations had verified=true and the
 * grounded pipeline never set it, so the most rigorously checked content on the
 * site displayed as "Basic · Unverified". A confidence signal that is
 * anti-correlated with actual confidence is worse than none.
 *
 * What replaces it is descriptive, not graded: who said it, whether a judge
 * checked it against a retrieved primary passage, when, and whether anything is
 * wrong with the match or the source.
 */

export type VerificationTone =
  | 'checked'     // a judge matched this claim to a retrieved primary passage
  | 'conflict'    // the passage disagrees with the card (often AU vs US practice)
  | 'weak'        // retrieved for this card, but not really about it
  | 'untrusted'   // the source itself failed a PaperLibrary trust scan
  | 'human'       // a person confirmed the link
  | 'unchecked';  // author-supplied; never independently checked

export interface EvidenceLinkView {
  relationship: string;
  isPrimary: boolean;
  groundingState: string | null;
  judgedAt: Date | null;
  judgedBy: string | null;
  corpusVersion: string | null;
  sourceTrust: string | null;
  matchCoverage: number | null;
  quote: string | null;
  humanVerified: boolean;
  humanVerifiedAt: Date | null;
}

/** Mirrors WEAK_MATCH_COVERAGE in scripts/audit/grounded/entailing-quote.ts. */
export const WEAK_MATCH_COVERAGE = 0.34;

/** Shortest run of text that can carry a clinical claim. */
const MIN_QUOTE_CHARS = 24;

/**
 * True when a stored "quote" is not a quotation at all.
 *
 * 2,248 CardCitation links carry the literal string `frontmatter cite: <slug>`
 * — a marker the authoring importer wrote where a quote belonged. Rendering it
 * in quotation marks tells the student we have evidence we do not have.
 */
export function isPlaceholderQuote(quote: string | null | undefined): boolean {
  if (!quote) return true;
  const t = quote.trim();
  if (t.length < MIN_QUOTE_CHARS) return true;
  if (/^frontmatter\s+cite\s*:/i.test(t)) return true;
  return false;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * One honest sentence about how far this citation has been checked.
 * Ordered by what should worry a reader most: a bad source outranks a good
 * verdict, and a mismatched passage outranks a confident one.
 */
export function describeVerification(link: EvidenceLinkView): { tone: VerificationTone; label: string } {
  if (link.sourceTrust === 'blocked') {
    return { tone: 'untrusted', label: 'Source failed an integrity check — treat with caution' };
  }

  const isConflict = link.relationship === 'contradicts'
    || link.groundingState === 'contradicted'
    || link.groundingState === 'miscited';
  if (isConflict) {
    return {
      tone: 'conflict',
      label: link.judgedAt
        ? `This source disagrees with the card — checked ${formatDate(link.judgedAt)}`
        : 'This source disagrees with the card',
    };
  }

  if (link.matchCoverage !== null && link.matchCoverage < WEAK_MATCH_COVERAGE) {
    return { tone: 'weak', label: 'Weak match — this passage may not be about this card' };
  }

  if (link.groundingState === 'supported' || link.groundingState === 'uncited-but-supported') {
    const when = link.judgedAt ? ` ${formatDate(link.judgedAt)}` : '';
    const model = link.judgedBy ? ` by ${link.judgedBy}` : '';
    return { tone: 'checked', label: `Checked against this passage${when}${model}` };
  }

  if (link.groundingState === 'unsupported') {
    return { tone: 'weak', label: 'No passage in the corpus was found to support this yet' };
  }

  if (link.humanVerified) {
    const when = link.humanVerifiedAt ? ` ${formatDate(link.humanVerifiedAt)}` : '';
    return { tone: 'human', label: `Confirmed by a reviewer${when}` };
  }

  return { tone: 'unchecked', label: 'Cited by the author; not independently checked' };
}

export interface EvidenceSummary {
  total: number;
  /** Links a judge actually ruled on (any grounding verdict). */
  checked: number;
  conflicting: number;
  /** Most recent judge date across all links, or null if never judged. */
  lastCheckedAt: Date | null;
}

/** Counts, not a grade. The reader draws the conclusion. */
export function summariseEvidence(links: EvidenceLinkView[]): EvidenceSummary {
  let checked = 0;
  let conflicting = 0;
  let lastCheckedAt: Date | null = null;
  for (const l of links) {
    if (l.groundingState) checked++;
    if (l.relationship === 'contradicts' || l.groundingState === 'contradicted') conflicting++;
    if (l.judgedAt && (!lastCheckedAt || l.judgedAt > lastCheckedAt)) lastCheckedAt = l.judgedAt;
  }
  return { total: links.length, checked, conflicting, lastCheckedAt };
}
