import { lookupGlossary } from './glossary';

export type { GlossaryEntry } from './glossary';
export { GLOSSARY, lookupGlossary, getAllTerms } from './glossary';

interface TermProps {
  /** The abbreviation/TLA. */
  abbr: string;
  /** Optional: override display text. */
  children?: React.ReactNode;
  /** Retained for back-compat with authored `<Term showFull>`; no longer renders differently. */
  showFull?: boolean;
}

/**
 * Term — renders an abbreviation, with an opt-in hover/tap decode tooltip.
 *
 * GATED on the glossary `decode` flag: ONLY genuinely-obscure terms (ITP, MMN,
 * CIDP, CMAP…) render the faint dotted-underline + tooltip. Everything else —
 * including the ~4,700 authored `<Term>` tags for trivial terms (ECG, BP, IV) —
 * renders plain. Keeping the affordance rare is exactly what avoids the visual
 * noise that retired the old decode-everything style on 2026-06-11 ("PaO2 is
 * weirdly font'd"). Pure-CSS tooltip (.term-tooltip in globals.css) — works on
 * hover (desktop) and focus/tap (mobile); no JS, no provider dependency.
 */
export function Term({ abbr, children }: TermProps) {
  const lookup = lookupGlossary(abbr);
  if (!lookup || lookup.entry.decode !== true) {
    return <>{children ?? abbr}</>;
  }
  return (
    <abbr
      className="term-tooltip cursor-help border-b border-dotted border-[var(--md-on-surface-variant)] text-[var(--md-on-surface)] no-underline"
      data-tooltip={lookup.entry.full}
      tabIndex={0}
      role="definition"
    >
      {children ?? lookup.abbr}
    </abbr>
  );
}
