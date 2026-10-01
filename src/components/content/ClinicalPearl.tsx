'use client';

import { type ReactNode } from 'react';
import { ContentFlag } from './ContentFlag';
import { CitationList } from './CitationList';
import { buildFlagId, extractText, normalizeSnapshot } from './content-flag-utils';
import { useJurisdictionFilter, JURISDICTION_LABELS } from '@/contexts/JurisdictionContext';
import { transformClozeChildren } from './transformClozeChildren';

interface ClinicalPearlProps {
  children: ReactNode;
  image?: string;
  imageUrl?: string;
  jurisdiction?: string;
  cite?: string;
}

export function ClinicalPearl({ children, jurisdiction, cite }: ClinicalPearlProps) {
  const shouldShow = useJurisdictionFilter(jurisdiction);

  if (!shouldShow) return null;

  const contentText = normalizeSnapshot(extractText(children));
  const snapshot = normalizeSnapshot(['Clinical Pearl', contentText].filter(Boolean).join(' '));
  const flagId = buildFlagId('ClinicalPearl', snapshot);

  return (
    <aside data-content-block className="callout callout-pearl">
      <header>
        <span className="title" style={{ color: 'var(--md-success)' }}>Clinical Pearl</span>
        {jurisdiction && jurisdiction !== 'national' && (
          <span className="badge badge-jurisdiction">
            {JURISDICTION_LABELS[jurisdiction] || jurisdiction.toUpperCase()}
          </span>
        )}
        <span className="actions">
          <CitationList cite={cite} />
          <ContentFlag targetType="component" targetId={flagId} componentType="ClinicalPearl" contentSnapshot={snapshot} />
        </span>
      </header>
      <div style={{ color: 'var(--md-on-surface)' }}>{transformClozeChildren(children)}</div>
    </aside>
  );
}
