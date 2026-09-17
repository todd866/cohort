'use client';

import { useState } from 'react';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';

/**
 * The open ask, at the top of the profile.
 *
 * Feedback used to live two taps down (Profile → Settings → Feedback) behind a
 * category dropdown, which is a form for someone who already knows their
 * request is a "bug" or a "feature". The people this is for do not: a learner
 * whose course md3 does not cover, or whose feed is wrong for them, has a
 * sentence to say and nowhere obvious to say it.
 *
 * So it leads, it is one box, and it names the loop it starts: these land in
 * the UserFeedback queue that the morning check reads every day, which is where
 * a custom feed gets decided. Category `request` marks that lane, alongside
 * `onboarding-other` from the rotation chooser.
 *
 * The prose is untrusted and stays that way — it is read by a person from the
 * moderation queue, never handed to an agent as an instruction.
 */
export function ProfileRequestBox() {
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // A bare `await fetch` here can hang forever and strand the button on
      // "Sending…" with no error and no way back — the same shape that wedged
      // the review feed on 2026-07-09. This form is the one place a learner is
      // told a person reads what they write, so it has to settle either way.
      const res = await fetchWithDeadline('/api/help', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          category: 'request',
          // Read from the document rather than usePathname: this box renders inside
          // a server page whose tests mock next/navigation narrowly, and the value
          // is only the breadcrumb stored beside the message.
          path: typeof window === 'undefined' ? null : window.location.pathname,
        }),
      }, CLIENT_FETCH_DEADLINE_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMessage('');
      setSent(true);
    } catch {
      setError('That did not send — check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <section
        aria-label="Requests"
        className="mb-6 rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-4 py-3"
      >
        <p className="text-sm text-[var(--md-on-surface)]">
          Sent. A person reads every one of these.
        </p>
        <button
          type="button"
          onClick={() => setSent(false)}
          className="mt-2 text-sm text-[var(--md-on-surface-variant)] underline-offset-2 hover:underline"
        >
          Ask for something else
        </button>
      </section>
    );
  }

  return (
    <section aria-label="Requests" className="mb-6">
      <form onSubmit={submit}>
        <label
          htmlFor="profile-request"
          className="block text-base font-semibold text-[var(--md-on-surface)]"
        >
          Ask for anything
        </label>
        <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
          In your own words: content your feed is missing, a topic to add, an
          exam you&rsquo;re sitting, something broken, a feature you want. These
          are read every morning.
        </p>
        <textarea
          id="profile-request"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          maxLength={5000}
          placeholder="e.g. GP registrar sitting the KFP in November: more prescribing and paediatrics, less obstetrics"
          className="mt-3 w-full rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-4 py-3 text-base placeholder:text-sm text-[var(--md-on-surface)] placeholder:text-[var(--md-on-surface-variant)]"
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-[var(--md-error)]">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || message.trim().length === 0}
          className="mt-3 rounded-xl bg-[var(--md-primary)] px-4 py-2.5 text-sm font-medium text-[var(--md-on-primary)] disabled:opacity-60"
        >
          {submitting ? 'Sending…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
