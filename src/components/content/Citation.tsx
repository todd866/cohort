export interface CitationProps {
  title?: string;
  href?: string;
  note?: string;
  id?: string;
  slug?: string;
  showReliability?: boolean;
  expandable?: boolean;
}

export function Citation({ title, href, note, id, slug }: CitationProps) {
  const label = title ?? slug ?? 'Citation';
  const content = (
    <>
      <span className="font-medium">{label}</span>
      {note ? <span className="opacity-70"> ({note})</span> : null}
    </>
  );
  const className = "inline-flex rounded-full bg-[var(--md-surface-container-high)] px-1.5 py-0.5 text-[11px] text-[var(--md-on-surface-variant)]";
  return href ? (
    <a id={id} className={className} href={href} target="_blank" rel="noopener noreferrer">
      {content}
    </a>
  ) : (
    <span id={id} className={className}>{content}</span>
  );
}
