'use client';

import { type ReactNode } from 'react';
import { ContentFlag } from './ContentFlag';
import { Citation } from './Citation';
import { buildFlagId, extractText, normalizeSnapshot } from './content-flag-utils';
import { useJurisdictionFilter, JURISDICTION_LABELS } from '@/contexts/JurisdictionContext';
import { transformClozeChildren } from './transformClozeChildren';

interface MnemonicProps {
  children: ReactNode;
  title?: string;
  image?: string;
  imageUrl?: string;
  jurisdiction?: string;
  cite?: string;
}

export function Mnemonic({ children, title, jurisdiction, cite }: MnemonicProps) {
  const shouldShow = useJurisdictionFilter(jurisdiction);

  if (!shouldShow) return null;

  const contentText = normalizeSnapshot(extractText(children));
  const snapshot = normalizeSnapshot([title || 'Mnemonic', contentText].filter(Boolean).join(' '));
  const flagId = buildFlagId('Mnemonic', snapshot);

  return (
    <aside data-content-block className="callout callout-mnemonic">
      <header>
        <span className="title" style={{ color: 'var(--mnemonic-border)' }}>{title || 'Mnemonic'}</span>
        {jurisdiction && jurisdiction !== 'national' && (
          <span className="badge badge-jurisdiction">
            {JURISDICTION_LABELS[jurisdiction] || jurisdiction.toUpperCase()}
          </span>
        )}
        <span className="actions">
          {cite && <Citation slug={cite.split('#')[0].split(':')[0]} note={cite.includes('#') ? cite.split('#')[1] : undefined} />}
          <ContentFlag targetType="component" targetId={flagId} componentType="Mnemonic" contentSnapshot={snapshot} />
        </span>
      </header>
      <div style={{ color: 'var(--md-on-surface)', fontFamily: 'var(--font-mono, monospace)' }}>{transformClozeChildren(children)}</div>
    </aside>
  );
}
