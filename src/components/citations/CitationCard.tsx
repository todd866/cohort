/**
 * CitationCard
 *
 * One citation, answering "what are we citing for this to be correct?" — the
 * source, the sentence in it that carries the claim, a way to go read it, and
 * an honest statement of how far it was checked.
 */

import type { CardCitationWithSource } from '@/lib/citations/evidence-tiers';
import { toEvidenceLinkView } from '@/lib/citations/evidence-tiers';
import { describeVerification, isPlaceholderQuote, type VerificationTone } from '@/lib/citations/evidence-presentation';

const TONE_STYLE: Record<VerificationTone, { color: string; icon: string }> = {
  checked:   { color: 'var(--md-on-success-container)', icon: '✓' },
  human:     { color: 'var(--md-on-success-container)', icon: '✓' },
  conflict:  { color: 'var(--md-error)', icon: '⚠' },
  untrusted: { color: 'var(--md-error)', icon: '⚠' },
  weak:      { color: 'var(--md-on-warning-container)', icon: '○' },
  unchecked: { color: 'var(--md-on-surface-variant)', icon: '○' },
};

export function CitationCard({ cc }: { cc: CardCitationWithSource }) {
  const view = toEvidenceLinkView(cc);
  const verification = describeVerification(view);
  const tone = TONE_STYLE[verification.tone];
  const isConflict = verification.tone === 'conflict' || verification.tone === 'untrusted';
  const showQuote = !isPlaceholderQuote(cc.citation.level2Quote);

  const source = cc.citation.source;
  const meta: string[] = [];
  if (source.jurisdiction) meta.push(source.jurisdiction.toUpperCase());
  if (source.sourceType) meta.push(SOURCE_TYPE_LABEL[source.sourceType] ?? source.sourceType);
  if (cc.citation.page) meta.push(cc.citation.page);

  return (
    <div
      className="p-3 rounded-[var(--md-radius-md)] border"
      style={{
        background: isConflict ? 'var(--md-error-container)' : 'var(--md-surface-container-high)',
        borderColor: cc.isPrimary && !isConflict ? 'var(--md-primary)' : 'transparent',
      }}
    >
      <div className="flex items-start gap-2 flex-wrap">
        {cc.isPrimary && !isConflict && (
          <span
            className="text-xs px-1.5 py-0.5 rounded-[var(--md-radius-xs)] font-medium"
            style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}
          >
            Primary
          </span>
        )}
        <span className="text-sm font-medium" style={{ color: 'var(--md-on-surface)' }}>
          {source.name || cc.citation.level1Text}
        </span>
      </div>

      {/* The sentence that carries the claim. Suppressed entirely when what is
          stored is an importer placeholder rather than a quotation. */}
      {showQuote ? (
        <blockquote
          className="text-sm mt-2 pl-3 border-l-2 italic"
          style={{ color: 'var(--md-on-surface-variant)', borderColor: 'var(--md-outline-variant)' }}
        >
          {cc.citation.level2Quote}
        </blockquote>
      ) : (
        <p className="text-xs mt-2 italic" style={{ color: 'var(--md-on-surface-variant)' }}>
          No supporting passage stored for this source yet.
        </p>
      )}

      {cc.jurisdictionNote && (
        <p className="text-xs mt-2" style={{ color: 'var(--md-tertiary)' }}>
          ⚠️ {cc.jurisdictionNote}
        </p>
      )}

      <div className="flex items-center gap-2 mt-2 flex-wrap text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>
        {meta.map((m) => (
          <span
            key={m}
            className="px-1.5 py-0.5 rounded-[var(--md-radius-xs)]"
            style={{ background: 'var(--md-surface-container)' }}
          >
            {m}
          </span>
        ))}
        {source.url && (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
            style={{ color: 'var(--md-primary)' }}
          >
            Open source ↗
          </a>
        )}
      </div>

      <div className="flex items-start gap-1 mt-2 text-xs" style={{ color: tone.color }}>
        <span aria-hidden>{tone.icon}</span>
        <span>{verification.label}</span>
      </div>

      {/* The audit trail itself: which corpus the passage came from. Shown only
          when a judge actually ran, so it never implies a check that never happened. */}
      {view.corpusVersion && (
        <p className="text-[11px] mt-1" style={{ color: 'var(--md-on-surface-variant)' }}>
          Corpus {view.corpusVersion}
          {view.sourceTrust ? ` · source integrity: ${view.sourceTrust}` : ''}
        </p>
      )}
    </div>
  );
}

const SOURCE_TYPE_LABEL: Record<string, string> = {
  guidelines: 'Guideline',
  textbook: 'Textbook',
  'peer-reviewed': 'Literature',
  lecture: 'Lecture',
  uptodate: 'UpToDate',
};
