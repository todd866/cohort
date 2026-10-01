'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';

// ── SupportSection ────────────────────────────────────────────
// Feedback-only. Content uploads live in the Documents accordion.

export function SupportSection() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [category, setCategory] = useState('general');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/help', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: message.trim(),
          category,
          path: pathname,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to submit');
      }

      setSuccess('Message sent');
      setMessage('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--md-primary)]">
        <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span>{success}</span>
        <button onClick={() => setSuccess(null)} className="ml-auto text-xs hover:underline">
          Done
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full text-left p-3 rounded-lg bg-[var(--md-surface)] hover:bg-[var(--md-surface-container-high)] transition-colors"
      >
        <div className="text-sm font-medium text-[var(--md-on-surface)]">Send feedback</div>
        <div className="text-xs text-[var(--md-on-surface-variant)]">
          Bug report, feature request, or question
        </div>
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--md-on-surface)]">Send feedback</span>
        <button
          type="button"
          onClick={() => { setOpen(false); setMessage(''); setError(null); }}
          className="text-xs text-[var(--md-on-surface-variant)] hover:underline"
        >
          Cancel
        </button>
      </div>

      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        className="w-full px-3 py-2 rounded-lg bg-[var(--md-surface)] border border-[var(--md-outline)] text-sm"
      >
        <option value="general">General question</option>
        <option value="bug">Something&apos;s broken</option>
        <option value="institution">Wrong institution / account</option>
        <option value="content">Content problem</option>
        <option value="feature">Feature request</option>
      </select>

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Describe what's happening..."
        rows={3}
        maxLength={5000}
        className="w-full px-3 py-2 rounded-lg bg-[var(--md-surface)] border border-[var(--md-outline)] text-sm resize-none"
      />

      {error && <div className="text-sm text-[var(--md-error)]">{error}</div>}

      <button
        type="submit"
        disabled={submitting || !message.trim()}
        className="px-4 py-2 rounded-lg bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] text-sm font-medium disabled:opacity-50"
      >
        {submitting ? 'Sending...' : 'Send'}
      </button>
    </form>
  );
}
