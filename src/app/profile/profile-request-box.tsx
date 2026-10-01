'use client';

import { useRef, useState } from 'react';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';

const MAX_MESSAGE_LENGTH = 50_000;
const MAX_REQUEST_LENGTH = 5_000;
const MAX_TEXT_FILE_BYTES = MAX_MESSAGE_LENGTH * 4;

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
/** Canvas results pages carry a mark per question. Detecting that lets the box
 *  tag the row so a morning check can route it, and raises the API's length cap
 *  from 5k to 50k — a 60-question results page does not fit in 5k. */
function looksLikeExamResults(text: string): boolean {
  return /Question\s+\d+\s*\n\s*[\d.]+\s*\/\s*[\d.]+\s*pts/.test(text);
}

export function ProfileRequestBox() {
  const [message, setMessage] = useState('');
  const messageRef = useRef(message);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Read a dropped text file into the box. Text only: a results page is text,
   *  and accepting arbitrary binaries would mean storage and scanning for no
   *  gain. A PDF is rejected with the one instruction that works. */
  const readFile = async (file: File) => {
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      setError('PDFs cannot be read here — open the results page, select all, and paste it instead.');
      return;
    }
    const hasTextMime = file.type.startsWith('text/');
    const hasTextExtensionWithoutMime = !file.type && /\.txt$/i.test(file.name);
    if (!hasTextMime && !hasTextExtensionWithoutMime) {
      setError('Please drop a text file, such as .txt, or paste the results page instead.');
      return;
    }
    if (file.size > MAX_TEXT_FILE_BYTES) {
      setError('That file is too large to read here. Keep it under 200 KB or paste a shorter results page.');
      return;
    }
    try {
      // `File.text()` is not available everywhere (jsdom lacks it, and so do
      // older mobile browsers), so fall back to FileReader rather than failing
      // silently and leaving the drop looking like it did nothing.
      const text =
        typeof file.text === 'function'
          ? await file.text()
          : await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result ?? ''));
              reader.onerror = () => reject(reader.error);
              reader.readAsText(file);
            });
      if (!text.trim()) { setError('That file looked empty.'); return; }
      const previous = messageRef.current.trim();
      const combined = previous ? `${previous}\n\n${text}` : text;
      if (combined.length > MAX_MESSAGE_LENGTH) {
        setError('That text would exceed the 50,000 character limit. Shorten the text already here or the file, then try again.');
        return;
      }
      setError(null);
      messageRef.current = combined;
      setMessage(combined);
    } catch {
      setError('That file could not be read — try pasting the text instead.');
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text || submitting) return;
    const isExamResults = looksLikeExamResults(text);
    const maxLength = isExamResults ? MAX_MESSAGE_LENGTH : MAX_REQUEST_LENGTH;
    if (text.length > maxLength) {
      setError(
        isExamResults
          ? 'Practice exam results must be 50,000 characters or fewer. Remove some results and try again.'
          : 'Requests must be 5,000 characters or fewer. Shorten your message and try again.',
      );
      return;
    }
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
          // `upload-` is what raises the API's 5k cap to 50k, so a pasted
          // results page is accepted whole rather than silently truncated.
          category: isExamResults ? 'upload-exam-result' : 'request',
          // Read from the document rather than usePathname: this box renders inside
          // a server page whose tests mock next/navigation narrowly, and the value
          // is only the breadcrumb stored beside the message.
          path: typeof window === 'undefined' ? null : window.location.pathname,
        }),
      }, CLIENT_FETCH_DEADLINE_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      messageRef.current = '';
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
          Tell us what to teach you
        </label>
        <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
          In your own words: content your feed is missing, a topic to add, an
          exam you&rsquo;re sitting, something broken, a feature you want. These
          are read every morning.
        </p>
        <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
          <strong className="font-semibold text-[var(--md-on-surface)]">
            Sat a practice exam?
          </strong>{' '}
          Drop the results file here, or paste the page. Which questions you got
          wrong is the most useful thing you can give us — it tells us what to
          teach harder, for everyone.
        </p>
        <textarea
          id="profile-request"
          value={message}
          onChange={(event) => {
            messageRef.current = event.target.value;
            setMessage(event.target.value);
          }}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer?.files?.[0];
            if (file) void readFile(file);
          }}
          rows={3}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder="e.g. GP registrar sitting the KFP in November: more prescribing and paediatrics, less obstetrics — or drop your exam results here"
          className={`mt-3 w-full rounded-xl border bg-[var(--md-surface-container)] px-4 py-3 text-base placeholder:text-sm text-[var(--md-on-surface)] placeholder:text-[var(--md-on-surface-variant)] ${
            dragging ? 'border-[var(--md-primary)]' : 'border-[var(--md-outline-variant)]'
          }`}
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
