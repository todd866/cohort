'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CohortSearchTopicV1 } from '@/lib/cohort/search-topic-contract';

interface CohortSearchOverlayProps {
  topics: readonly CohortSearchTopicV1[];
  activeTopicId: string | null;
  onSelect: (topicId: string) => void;
  onClear: () => void;
  disabled?: boolean;
}

function normaliseSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function topicSearchText(topic: CohortSearchTopicV1): string {
  return normaliseSearchText([
    topic.label,
    ...topic.aliases,
    ...topic.searchIntents,
    ...topic.learningOutcomes,
  ].join(' '));
}

export function CohortSearchOverlay({
  topics,
  activeTopicId,
  onSelect,
  onClear,
  disabled = false,
}: CohortSearchOverlayProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const activeTopic = topics.find((topic) => topic.id === activeTopicId) ?? null;
  const normalizedQuery = normaliseSearchText(query);
  const matches = useMemo(() => {
    if (!normalizedQuery) return [...topics];
    const tokens = normalizedQuery.split(' ');
    return topics.filter((topic) => {
      const haystack = topicSearchText(topic);
      return tokens.every((token) => haystack.includes(token));
    });
  }, [normalizedQuery, topics]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="flex items-center gap-2">
      {activeTopic && (
        <span className="inline-flex max-w-[13rem] items-center gap-1 rounded-full bg-[var(--md-primary-container)] px-2 py-1 text-xs text-[var(--md-on-primary-container)]">
          <span className="truncate">Learning: {activeTopic.label}</span>
          <button
            type="button"
            aria-label={`Clear ${activeTopic.label} focus`}
            disabled={disabled}
            onClick={onClear}
            className="rounded-full px-1 font-semibold hover:bg-black/10 disabled:cursor-not-allowed disabled:opacity-45"
          >
            ×
          </button>
        </span>
      )}
      <button
        type="button"
        disabled={disabled || topics.length === 0}
        onClick={() => setOpen(true)}
        className="rounded-md px-2 py-1 text-xs text-[var(--md-on-surface-variant)] transition-colors hover:bg-[var(--md-surface-container-high)] hover:text-[var(--md-on-surface)] disabled:cursor-not-allowed disabled:opacity-45"
      >
        Search the deck
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-start justify-center bg-black/35 px-4 pt-[max(4rem,env(safe-area-inset-top))] backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) close();
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="cohort-search-title"
            className="flex max-h-[min(78vh,42rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[var(--md-outline-soft)] bg-[var(--md-surface)] shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-[var(--md-outline-soft)] px-5 py-4">
              <div>
                <h2 id="cohort-search-title" className="text-lg font-semibold text-[var(--md-on-surface)]">
                  What do you want to learn?
                </h2>
                <p className="mt-1 text-xs text-[var(--md-on-surface-variant)]">
                  Your typing stays in this browser. We record only a topic you choose.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close search"
                onClick={close}
                className="rounded-full px-2 py-1 text-lg text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]"
              >
                ×
              </button>
            </div>

            <div className="px-5 py-4">
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="ECG, kidneys, childhood rashes…"
                className="w-full rounded-xl border border-[var(--md-outline)] bg-[var(--md-surface-container-low)] px-4 py-3 text-base text-[var(--md-on-surface)] outline-none focus:border-[var(--md-primary)] focus:ring-2 focus:ring-[var(--md-primary)]/20"
              />
            </div>

            <div className="overflow-y-auto px-3 pb-4">
              {matches.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-[var(--md-on-surface-variant)]">
                  No reviewed topic matches yet. Try a broader medical term.
                </p>
              ) : (
                <ul className="space-y-1">
                  {matches.map((topic) => (
                    <li key={topic.id}>
                      <button
                        type="button"
                        aria-label={`Learn ${topic.label}`}
                        onClick={() => {
                          onSelect(topic.id);
                          close();
                        }}
                        className="w-full rounded-xl px-3 py-3 text-left transition-colors hover:bg-[var(--md-surface-container-high)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--md-primary)]"
                      >
                        <span className="flex items-center justify-between gap-3">
                          <span className="font-medium text-[var(--md-on-surface)]">{topic.label}</span>
                          <span className="shrink-0 text-xs text-[var(--md-on-surface-variant)]">
                            {topic.eligibleItemCount} in deck
                          </span>
                        </span>
                        {topic.learningOutcomes[0] && (
                          <span className="mt-1 block text-sm text-[var(--md-on-surface-variant)]">
                            {topic.learningOutcomes[0]}
                          </span>
                        )}
                        {topic.modalities.some((modality) => modality !== 'text') && (
                          <span className="mt-2 block text-[11px] uppercase tracking-wide text-[var(--md-primary)]">
                            {topic.modalities.filter((modality) => modality !== 'text').join(' · ')}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
