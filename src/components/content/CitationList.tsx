'use client';

import { parseCiteReferenceList } from '@/lib/cite-utils';
import { Citation } from './Citation';

interface CitationListProps {
  cite?: string;
}

/** Render every registered reference in a semicolon-delimited cite attribute. */
export function CitationList({ cite }: CitationListProps) {
  const references = parseCiteReferenceList(cite ?? '');

  if (references.length === 0) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {references.map((reference, index) => (
        <Citation
          key={`${reference.sourceSlug}#${reference.section ?? ''}:${index}`}
          slug={reference.sourceSlug}
          note={reference.section}
        />
      ))}
    </span>
  );
}
