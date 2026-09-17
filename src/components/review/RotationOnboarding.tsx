'use client';

import { useState } from 'react';
import { rotationLabel } from '@/lib/rotation-labels';
import { fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';

// Full names for first-contact users — the short codes (CC, PAAM) mean
// nothing before you know the course.
const FULL_NAMES: Record<string, string> = {
  'critical-care': 'Critical Care',
  paam: 'Psychiatry & Addiction Medicine',
  cah: 'Child & Adolescent Health',
  pwh: 'Perinatal & Women’s Health',
};

interface RotationOnboardingProps {
  /** Scheduled rotation slugs for the user's institution, in calendar order. */
  rotations: string[];
  /** Called after the choice is saved server-side (modules + inferred track). */
  onDone: () => void;
  /** Optional escape hatch — keeps the default feed for "just exploring". */
  onSkip?: () => void;
}

/**
 * One-time rotation chooser for anyone — signed in OR a guest — with NO
 * studyable rotations. Before this existed, a new signup was silently dropped
 * onto scheduledRotations[0] with no way to pick their stream on mobile, and
 * real first sessions served the wrong rotation end to end (2026-08-18/19).
 *
 * Guests were added 2026-08-23: they were still being dropped on the CAH
 * acquisition default, so a Critical Care student studied paediatrics for 48
 * minutes before registering. Saving posts to /api/user/rotation, which
 * accepts a guest, syncs activeModules and infers the track so later block
 * changes auto-advance. The guest's answer is carried onto their account by
 * claimGuestProgressRecords, so the question is never asked twice.
 */
export function RotationOnboarding({ rotations, onDone, onSkip }: RotationOnboardingProps) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [describing, setDescribing] = useState(false);
  const [description, setDescription] = useState('');

  // Whoever is not on the list still has to land somewhere, so "something else"
  // ends where "skip" ends: the default feed. It must NOT call onDone, which
  // reloads — with no rotation saved the reload would ask the same question
  // again, which is what the free-text answer was meant to spare them.
  const leaveWithoutARotation = onSkip ?? onDone;

  // Name the deck they will actually get rather than calling it "the default".
  // Somebody who has just explained that they are a GP registrar deserves to
  // know they are about to be served paediatrics, and to decide for themselves
  // whether that is worth their time today.
  const meanwhileDeck = FULL_NAMES[rotations[0] ?? ''] ?? 'the default deck';

  /**
   * Their answer is a support message, not a setting.
   *
   * /api/user/curriculum-request files it in the human moderation queue under
   * `onboarding-other`, where the morning check turns it into an actual feed,
   * and stamps the user so this question is never asked of them again. Three
   * things follow and none is incidental: no rotation is written, because
   * guessing one is exactly the bug the chooser exists to prevent; the prose is
   * untrusted and stays quarantined behind that queue's review boundary; and a
   * failed send never strands the learner on a form.
   */
  const sendDescription = async () => {
    const message = description.trim();
    if (!message || saving) return;
    setSaving('other');
    try {
      await fetchWithDeadline('/api/user/curriculum-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: message }),
      }, CLIENT_FETCH_DEADLINE_MS);
    } catch {
      // Deliberately swallowed: see above.
    }
    leaveWithoutARotation();
  };

  const pick = async (rotation: string) => {
    if (saving) return;
    setSaving(rotation);
    setError(null);
    try {
      const res = await fetchWithDeadline('/api/user/rotation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotation }),
      }, CLIENT_FETCH_DEADLINE_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onDone();
    } catch {
      setError('Could not save your choice — check your connection and tap again.');
      setSaving(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-xl font-semibold text-[var(--md-on-surface)]">
        What are you studying right now?
      </h1>
      <p className="mt-2 text-sm text-[var(--md-on-surface-variant)]">
        Pick your current rotation and we&rsquo;ll build your queue from it.
        You can change this any time.
      </p>
      <div className="mt-6 flex flex-col gap-3">
        {rotations.map((rotation) => (
          <button
            key={rotation}
            type="button"
            disabled={saving !== null}
            onClick={() => void pick(rotation)}
            className="w-full rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-4 py-3.5 text-left text-base font-medium text-[var(--md-on-surface)] transition-colors hover:bg-[var(--md-surface-container-high)] disabled:opacity-60"
          >
            {FULL_NAMES[rotation] ?? rotationLabel(rotation)}
            <span className="ml-2 text-sm text-[var(--md-on-surface-variant)]">
              {rotationLabel(rotation)}
            </span>
            {saving === rotation ? '…' : ''}
          </button>
        ))}
      </div>
      {!describing && (
        <button
          type="button"
          disabled={saving !== null}
          onClick={() => setDescribing(true)}
          className="mt-3 w-full rounded-xl border border-dashed border-[var(--md-outline-variant)] px-4 py-3.5 text-left text-base font-medium text-[var(--md-on-surface-variant)] transition-colors hover:bg-[var(--md-surface-container)] disabled:opacity-60"
        >
          Something else
          <span className="ml-2 text-sm">
            another university, rotation or job
          </span>
        </button>
      )}
      {describing && (
        <div className="mt-4">
          <label
            htmlFor="onboarding-other"
            className="block text-sm text-[var(--md-on-surface)]"
          >
            Tell us as much as you can about what you&rsquo;re trying to learn —
            the exam and its date, and the university, rotation or job it is for.
          </label>
          <textarea
            id="onboarding-other"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
            maxLength={5000}
            placeholder="e.g. GP registrar sitting the RACGP KFP on 12 November; trained at Otago, working in rural ED."
            className="mt-2 w-full rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-4 py-3 text-base text-[var(--md-on-surface)] placeholder:text-[var(--md-on-surface-variant)]"
          />
          <button
            type="button"
            disabled={saving !== null || description.trim().length === 0}
            onClick={() => void sendDescription()}
            className="mt-3 w-full rounded-xl bg-[var(--md-primary)] px-4 py-3.5 text-base font-medium text-[var(--md-on-primary)] transition-opacity disabled:opacity-60"
          >
            Send and start studying
          </button>
          <p className="mt-2 text-sm text-[var(--md-on-surface-variant)]">
            A person reads these, usually within a day. Until your feed is set
            up you&rsquo;ll study {meanwhileDeck}, and you won&rsquo;t be asked
            this again.
          </p>
        </div>
      )}
      {error && (
        <p className="mt-4 text-sm text-[var(--md-error)]" role="alert">
          {error}
        </p>
      )}
      {onSkip && (
        <button
          type="button"
          onClick={onSkip}
          className="mt-6 w-full text-center text-sm text-[var(--md-on-surface-variant)] underline-offset-2 hover:underline"
        >
          Skip for now
        </button>
      )}
    </div>
  );
}
