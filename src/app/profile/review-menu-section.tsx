'use client';

import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';
import type { ReviewMenuChoice } from '@/lib/study/review-menu';

export function ReviewMenuSection({ choices }: { choices: ReviewMenuChoice[] }) {
  const { mutate } = useSWRConfig();
  const [items, setItems] = useState(choices);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(slug: string, checked: boolean) {
    const previous = items;
    const next = items.map((item) => (item.slug === slug ? { ...item, checked } : item));
    setItems(next);
    setSaving(true);
    setError(null);
    try {
      const response = await fetchWithDeadline('/api/user', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewMenuModules: next.filter((item) => item.checked).map((item) => item.slug),
        }),
      }, CLIENT_FETCH_DEADLINE_MS);
      if (!response.ok) throw new Error('save failed');
      await mutate(
        (key) => Array.isArray(key) && key[0] === '/api/user/minimal',
      );
    } catch {
      setItems(previous);
      setError('Could not save the review menu. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const groups = groupChoices(items);

  return (
    <section
      aria-label="Review menu"
      className="mb-4 rounded-xl border border-[var(--md-outline-variant)] px-4 py-3"
    >
      <h2 className="mb-3 text-sm font-semibold text-[var(--md-on-surface)]">Review menu</h2>
      {/* Chips, not a checkbox column: 25 decks as one row each ran to three
          screens. The checkbox stays real for keyboard and screen readers. */}
      <div className="space-y-2.5">
        {groups.map((group) => (
          <fieldset key={group.title} className="sm:flex sm:items-baseline sm:gap-3">
            <legend className="float-left mb-1 text-xs font-medium text-[var(--md-on-surface-variant)] sm:mb-0 sm:w-14 sm:shrink-0">
              {group.title}
            </legend>
            <div className="clear-left flex flex-wrap gap-1.5 sm:clear-none">
              {group.items.map((item) => (
                <label
                  key={item.slug}
                  title={item.pinned ? 'Current block' : undefined}
                  className={[
                    'inline-flex min-h-8 items-center gap-1 rounded-full border px-3 text-sm',
                    'border-[var(--md-outline-variant)] text-[var(--md-on-surface-variant)]',
                    'has-checked:border-[var(--md-primary)] has-checked:bg-[var(--md-primary-container)] has-checked:text-[var(--md-on-primary-container)]',
                    'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-[var(--md-primary)]',
                    item.pinned ? 'font-semibold' : 'cursor-pointer hover:bg-[var(--md-surface-container-high)]',
                  ].join(' ')}
                >
                  <input
                    type="checkbox"
                    checked={item.checked}
                    disabled={item.pinned || saving}
                    onChange={(event) => { void toggle(item.slug, event.target.checked); }}
                    className="sr-only"
                  />
                  {item.checked && <span aria-hidden="true">✓</span>}
                  <span>{item.label}</span>
                  {item.pinned && <span className="sr-only">Current block</span>}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--md-error)]">{error}</p>
      )}
    </section>
  );
}

const BLOCK_SLUGS = new Set(['critical-care', 'cah', 'paam', 'pwh', 'year3-common']);
const EXAM_SLUGS = new Set(['year1-kat1', 'year1-kat2', 'year1-kat3', 'usmle-step1-open', 'bpt']);

/** Blocks, exams, then every other deck, each keeping the server's order. */
export function groupChoices(items: ReviewMenuChoice[]) {
  const groups = [
    { title: 'Blocks', items: items.filter((item) => BLOCK_SLUGS.has(item.slug)) },
    { title: 'Exams', items: items.filter((item) => EXAM_SLUGS.has(item.slug)) },
    {
      title: 'Decks',
      items: items.filter((item) => !BLOCK_SLUGS.has(item.slug) && !EXAM_SLUGS.has(item.slug)),
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}
