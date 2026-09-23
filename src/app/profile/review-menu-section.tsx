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

  return (
    <section
      aria-label="Review menu"
      className="mb-4 rounded-xl border border-[var(--md-outline-variant)] px-4 py-3"
    >
      <h2 className="text-sm font-semibold text-[var(--md-on-surface)]">Review menu</h2>
      <p className="mt-0.5 mb-3 text-xs text-[var(--md-on-surface-variant)]">
        Choose which modules appear while studying. Your current block stays listed.
      </p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.slug}>
            <label className={[
              'flex items-center gap-3 rounded-lg px-2 py-1.5',
              item.pinned ? '' : 'cursor-pointer hover:bg-[var(--md-surface-container-high)]',
            ].join(' ')}>
              <input
                type="checkbox"
                checked={item.checked}
                disabled={item.pinned || saving}
                onChange={(event) => { void toggle(item.slug, event.target.checked); }}
                className="h-4 w-4 rounded accent-[var(--md-primary)]"
              />
              <span className="text-sm text-[var(--md-on-surface)]">{item.label}</span>
              {item.pinned && (
                <span className="text-xs text-[var(--md-on-surface-variant)]">Current block</span>
              )}
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--md-error)]">{error}</p>
      )}
    </section>
  );
}
