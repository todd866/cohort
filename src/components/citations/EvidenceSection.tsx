/**
 * EvidenceSection
 *
 * The answer to "what are we citing for this to be correct?".
 *
 * Deliberately NOT grouped by an evidence-tier taxonomy any more. 2,854 of the
 * 2,898 grounded entries carry tier "unknown", which the pipeline mapped to
 * peer-reviewed and the page then labelled "Research Evidence — RCTs,
 * meta-analyses, landmark trials". Kumar & Clark, Bailey & Love, Toronto Notes
 * and Robbins all displayed under that heading. Where the kind of source is
 * genuinely known it is shown as a chip on the citation itself; where it is not,
 * the source's own name is the honest description and no taxonomy is invented.
 *
 * Supporting evidence and conflicting evidence ARE separated, because a passage
 * that disagrees with the card is a different thing to read.
 */

import type { CardCitationWithSource } from '@/lib/citations/evidence-tiers';
import { toEvidenceLinkView } from '@/lib/citations/evidence-tiers';
import { summariseEvidence } from '@/lib/citations/evidence-presentation';
import { CitationCard } from './CitationCard';

export function EvidenceSection({ citations }: { citations: CardCitationWithSource[] }) {
  const views = citations.map(toEvidenceLinkView);
  const summary = summariseEvidence(views);

  const conflicting = citations.filter(
    (cc) => cc.relationship === 'contradicts' || cc.groundingState === 'contradicted',
  );
  const supporting = citations.filter((cc) => !conflicting.includes(cc));

  return (
    <section className="mb-6">
      <h2
        className="text-sm font-medium mb-3 uppercase tracking-wide"
        style={{ color: 'var(--md-on-surface)' }}
      >
        Evidence
      </h2>

      {/* Counts, not a grade. */}
      <p className="text-xs mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>
        {summary.total} source{summary.total === 1 ? '' : 's'}
        {summary.checked > 0
          ? ` · ${summary.checked} checked against primary literature`
          : ' · none independently checked'}
        {summary.conflicting > 0 ? ` · ${summary.conflicting} conflicting` : ''}
        {summary.lastCheckedAt
          ? ` · last checked ${summary.lastCheckedAt.toLocaleDateString('en-AU', {
              day: 'numeric', month: 'short', year: 'numeric',
            })}`
          : ''}
      </p>

      <div className="space-y-2">
        {supporting.map((cc) => (
          <CitationCard key={cc.id} cc={cc} />
        ))}
      </div>

      {conflicting.length > 0 && (
        <div className="mt-4">
          <h3
            className="text-xs font-medium mb-2 uppercase tracking-wide"
            style={{ color: 'var(--md-error)' }}
          >
            Conflicting evidence
          </h3>
          <p className="text-xs mb-2" style={{ color: 'var(--md-on-surface-variant)' }}>
            A retrieved passage disagrees with this card. That is often a real
            Australian-vs-overseas practice difference rather than an error — read
            the passage before changing what you know.
          </p>
          <div className="space-y-2">
            {conflicting.map((cc) => (
              <CitationCard key={cc.id} cc={cc} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Renders NOTHING.
 *
 * An absent citation is a WORKLIST, not a warning. 92.7% of the corpus carries
 * no citation, so the old notice ("Treat it as unverified teaching content")
 * told nearly every learner, on nearly every card, to distrust what they were
 * reading — while the actual response is to go and find the source. Owner's
 * call, and it was still live on /cards/[id] on 2026-09-19.
 *
 * Kept as a no-op component rather than deleted so the card and question pages
 * keep their explicit "no citations" branch, and so restoring a notice later is
 * a change in one place.
 */
export function NoEvidenceNotice() {
  return null;
}
